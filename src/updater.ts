/**
 * The updater an app talks to: one object made from one config.
 *
 *   check()    what the feed offers, from this build's point of view, with a cache so however
 *              often a page asks, the feed is asked at most once per TTL.
 *   install()  download this platform's release, verify it, and put it in place — or, where an
 *              installer does the installing, stage it to run as the app quits.
 *   relaunch() finish as the app quits: run the staged installer, or start the new copy.
 *
 * A release is installed WHOLE, from the same file a person downloads (`assetName` names it):
 *
 *   macOS    the DMG. Its `.app` is copied out, verified and swapped in while the app runs
 *            (swap-bundle.ts); the restart starts the new one.
 *   Windows  the installer. It is downloaded and verified now, and run as the app quits, told to
 *            wait for this process, install over it unattended and start the app again
 *            (`installer` in the config). Nothing is replaced while the app runs.
 *   Linux    nothing in place: a package install needs root. `check()` says so, and the app
 *            offers the download page.
 *
 * Nothing here knows how the app is served, drawn or stopped. The app supplies `busy()` (why an
 * install must wait: a job in flight, a child process alive) and reads events; the HTTP shape
 * is in http.ts for apps that want it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { downloadTo } from './download'
import { type InstallErrorCode, UpdateError } from './errors'
import { type InstallerHandoff, cleanUpAfterUpdate, finishUpdate, stageDir, writePendingInstaller } from './relaunch'
import { ReleaseFeedError, type Release, type ReleaseAsset, type ReleaseSource } from './source'
import { applyBundleUpdate } from './swap-bundle'
import { type InstallTarget, blockedReason, installTarget, targetName } from './target'
import { compareVersions } from './version'

export interface UpdaterConfig {
  /** For messages: "<appName> can't write to the folder it's in." */
  appName: string
  /** The running build's version, strict `X.Y.Z`. */
  version: string
  source: ReleaseSource
  /**
   * The release's download for `target` (`windows-x64`, `darwin-arm64`, …), by asset name, or
   * null when the release has none for it: the DMG on macOS, the installer on Windows.
   */
  assetName: (version: string, target: string) => string | null
  platform?: NodeJS.Platform
  arch?: string
  execPath?: string
  /** macOS: the executable's name under Contents/MacOS. Defaults to the running one's. */
  bundleExecutable?: string
  /** Windows: how to run the downloaded installer unattended. Without it, Windows offers the download page. */
  installer?: InstallerHandoff
  /** Why an install must wait right now (a job running, a child process alive), or null. */
  busy?: () => string | null
  /**
   * Why this copy must not install in place, beyond what the updater checks itself (the platform,
   * the folder, the disk), or null. Unlike `busy`, a reason to offer the download page rather
   * than to wait: an app run with no window to restart from, say. Asked on every check.
   */
  blocked?: () => string | null
  /** How long a check's answer is reused. Default 30 minutes. */
  checkTtlMs?: number
  /** Where the download is staged. Default: the OS temp directory. */
  downloadDir?: string
  /** Where the updater's diagnostics go. Without it, only failures are written, with `console.warn`. */
  log?: (line: string) => void
  /** Test seam: replaces the macOS swap. */
  apply?: (file: string, target: InstallTarget, events: InstallEventSink, signal?: AbortSignal) => Promise<void>
}

/** What `check()` answers. */
export interface UpdateInfo {
  current: string
  /** This build's platform name, as the release's downloads name it. */
  target: string
  /** A newer published release WITH a download for this target, or null. `size` is that download's. */
  latest: { version: string; url: string; size: number } | null
  /** The version installed (macOS) or staged to install as the app quits (Windows); null when none is. */
  installed: string | null
  /** Why an in-place install is impossible here, so the UI offers the download page; null when it can. */
  blocked: string | null
  /**
   * The last ask of the feed failed (offline, the feed down, rate-limited): `latest` is null for
   * want of an answer, not because there is no update. A page asks again sooner than it would
   * after an answer — the cached failure is asked again after a minute.
   */
  checkFailed: boolean
}

export type InstallEvent =
  | { type: 'checking' }
  | { type: 'downloading'; received: number; total: number }
  | { type: 'verifying' }
  /** `total` 0: how far the step has got is not known (the macOS unpack reports none), so show it as indeterminate. */
  | { type: 'unpacking'; done: number; total: number }
  | { type: 'swapping' }
  | { type: 'done'; ok: true; version: string }
  | { type: 'done'; ok: false; code: InstallErrorCode; message: string }

export type InstallEventSink = (event: InstallEvent) => void

export interface Updater {
  check(opts?: { force?: boolean; signal?: AbortSignal }): Promise<UpdateInfo>
  install(opts: { onEvent: InstallEventSink; signal?: AbortSignal }): Promise<{ version: string }>
  /** The version install() put in place or staged, or null. */
  installedVersion(): string | null
  /** Whether an install is running right now. */
  installing(): boolean
  target(): InstallTarget | null
  /**
   * Finish as the app quits (`finishUpdate`): run a staged installer, then start the new copy.
   * Await it before exiting. Always a promise here; `void` is allowed so an app's test fake can
   * stay `() => {}`.
   */
  relaunch(): Promise<void> | void
  /**
   * Remove a previous update's leftovers; call at launch. Does nothing once an install has
   * started, since by then this process's own download folder holds what the quit runs.
   */
  cleanUp(): void
  /** The release the last check found, newer or not. */
  lastRelease(): Release | null
}

type Strategy = 'bundle' | 'installer'

/** One ask of the feed, shared by every check until it goes stale. `failed` is set before `release` settles. */
interface CheckEntry {
  at: number
  release: Promise<Release | null>
  failed: boolean
}

const DEFAULT_TTL = 30 * 60_000
/**
 * Even a forced check waits this long after the previous one: the feed is shared with everything
 * else on this address. A FAILED check is asked again after it too, forced or not, so an app that
 * started offline finds the update soon after the connection comes back.
 */
const RECHECK_FLOOR = 60_000

export function createUpdater(config: UpdaterConfig): Updater {
  const platform = config.platform ?? process.platform
  const arch = config.arch ?? process.arch
  const target = installTarget({ execPath: config.execPath, platform })
  const targetId = targetName(platform, arch)
  const ttl = config.checkTtlMs ?? DEFAULT_TTL
  const log = config.log ?? (() => {})
  // Failures are written somewhere even when the app gives no `log`: what the user is shown is
  // deliberately plain (no paths, no errnos), so this line is the only record of what happened.
  const warn = config.log ?? ((line: string) => console.warn(`[${config.appName} updater] ${line}`))
  const stage = { downloadDir: config.downloadDir }
  // How this install takes an update, or null where it can't in place.
  const strategy: Strategy | null = !target ? null : target.layout === 'bundle' ? 'bundle' : platform === 'win32' && config.installer ? 'installer' : null
  /**
   * Space the install needs on the app's volume, as a multiple of the download: the download
   * itself, and a whole unpacked copy written while the old one is kept to fall back on. A bundle
   * is unpacked beside the installed one; an installer moves the old version aside (renames, no
   * space) and writes the new one in full. A compressed release unpacks to two or three times
   * its download, so 4: under it, the install runs out of space part way and fails every time.
   */
  const spaceFactor = 4

  let installed: string | null = null
  let installing = false
  let lastCheck: CheckEntry | null = null
  let lastRelease: Release | null = null
  // What the last check said about installing in place. Working it out writes a probe file into
  // the install folder and stats its volume (blockedReason), and a page polls; on Windows every
  // probe is also a Defender scan. So it is worked out again only when the feed is asked again,
  // or the download it is sized for changes. install() always asks afresh.
  let blockedCache: { needBytes: number; reason: string | null } | null = null

  const assetFor = (release: Release): ReleaseAsset | null => {
    const name = config.assetName(release.version, targetId)
    return name ? (release.assets.find((a) => a.name === name) ?? null) : null
  }
  const isNewer = (release: Release | null): release is Release => !!release && compareVersions(release.version, config.version) > 0

  const whyBlocked = (needBytes = 0): string | null => {
    if (target && !strategy) return `${config.appName} can't install updates by itself on ${osName(platform)}. Download the update instead.`
    return blockedReason(target, { platform, appName: config.appName, needBytes })
  }
  /** The app's own reason, after the updater's: asked every time, it is not cached with them. */
  const appBlocked = (): string | null => config.blocked?.() ?? null

  const describe = (release: Release | null, checkFailed = false): UpdateInfo => {
    const asset = isNewer(release) ? assetFor(release) : null
    const latest = release && asset ? { version: release.version, url: release.url, size: asset.size } : null
    const needBytes = latest ? latest.size * spaceFactor : 0
    if (blockedCache?.needBytes !== needBytes) blockedCache = { needBytes, reason: whyBlocked(needBytes) }
    return {
      current: config.version,
      target: targetId,
      latest,
      installed,
      blocked: blockedCache.reason ?? appBlocked(),
      checkFailed,
    }
  }

  const fetchRelease = async (signal?: AbortSignal): Promise<Release | null> => {
    const release = await config.source.latest(signal)
    lastRelease = release
    return release
  }

  const check: Updater['check'] = async (opts = {}) => {
    if (installed) return describe(null)
    const age = lastCheck ? Date.now() - lastCheck.at : Infinity
    // A forced check (the user clicked) may ask again sooner than the TTL, but not sooner than
    // the floor — unless the last answer was a failure, which is exactly what a click retries.
    // A failed answer is not kept for the TTL either: offline at launch must not mean no update
    // for half an hour after the connection is back.
    const stale = !lastCheck || age > ttl || (lastCheck.failed ? opts.force || age > RECHECK_FLOOR : opts.force && age > RECHECK_FLOOR)
    if (stale) {
      // Offline, or the feed is down: no update to offer, and nothing worth telling the user
      // from a background check. A forced check surfaces the reason.
      //
      // The answer is cached for every page that asks, so the fetch runs under none of their
      // signals: one page reloading mid-check would otherwise cache "no update" for the TTL.
      const release = fetchRelease()
      const entry: CheckEntry = {
        at: Date.now(),
        // One handler, so `failed` is set before anyone awaiting the answer reads it.
        release: release.then(
          (found) => found,
          (err) => {
            entry.failed = true
            warn(`check failed: ${errorText(err)}`)
            return null
          },
        ),
        failed: false,
      }
      lastCheck = entry
      // Asked again with the feed: the disk may have been cleared, or the folder made writable.
      blockedCache = null
      if (opts.force) {
        try {
          await untilAborted(release, opts.signal)
        } catch (err) {
          // The feed's own errors are written to be shown; anything else is raw, and only logged.
          if (err instanceof ReleaseFeedError || err instanceof UpdateError) throw err
          throw new ReleaseFeedError(UNREACHABLE, 'offline')
        }
      }
    }
    const entry = lastCheck!
    const release = await untilAborted(entry.release, opts.signal)
    return describe(release, entry.failed)
  }

  const install: Updater['install'] = async ({ onEvent, signal }) => {
    const fail = (code: InstallErrorCode, message: string, cause?: unknown): never => {
      throw new UpdateError(code, message, { cause })
    }
    const dir = stageDir(config.appName, stage)
    let owned = false
    let keepStage = false
    try {
      if (installed) fail('already_installed', `${config.appName} ${installed} is already installed. Restart ${config.appName} to finish.`)
      if (installing) fail('in_progress', 'An update is already being installed.')
      installing = true
      owned = true
      const busy = config.busy?.()
      if (busy) fail('busy', `${config.appName} can't update while ${busy}. Try again when it's finished.`)
      const blocked = whyBlocked() ?? appBlocked()
      if (blocked || !target || !strategy) fail('blocked', blocked ?? `${config.appName} is running from source.`)

      onEvent({ type: 'checking' })
      let release: Release | null = null
      try {
        release = await fetchRelease(signal)
        lastCheck = { at: Date.now(), release: Promise.resolve(release), failed: false }
      } catch (err) {
        // Only this install's own signal is a cancel. A feed's timeout is the network.
        if (signal?.aborted) fail('cancelled', 'The update was cancelled.', err)
        const feed = err instanceof ReleaseFeedError ? err : null
        fail('offline', feed?.message ?? UNREACHABLE, err)
      }
      const asset = isNewer(release) ? assetFor(release) : null
      if (!asset) return fail('no_update', "There's no newer version to install.")
      const needBlocked = whyBlocked(asset.size * spaceFactor)
      if (needBlocked) fail('blocked', needBlocked)

      const file = path.join(dir, asset.name)
      log(`downloading ${asset.name} from ${asset.url} -> ${file}`)
      onEvent({ type: 'downloading', received: 0, total: asset.size })
      await downloadTo(asset.url, file, {
        size: asset.size,
        sha256: asset.sha256 ?? '',
        signal,
        onProgress: (received, total) => onEvent({ type: 'downloading', received, total }),
        onVerifying: () => onEvent({ type: 'verifying' }),
      })

      // Asked again: a job may have started during a long download, and the swap (or the quit
      // that runs the installer) is the step that must not happen under one.
      const busyNow = config.busy?.()
      if (busyNow) fail('busy', `${config.appName} can't update while ${busyNow}. Try again when it's finished.`)

      if (strategy === 'bundle') {
        // Total 0, not 1: the copy and the signature check report no progress, and `done: 0 of 1`
        // drew an empty bar for the minute they take, as if the update had stalled.
        onEvent({ type: 'unpacking', done: 0, total: 0 })
        await (config.apply ?? defaultApply)(file, target!, onEvent, signal)
      } else {
        // Windows: nothing is replaced while the app runs. The installer runs as it quits (relaunch()).
        writePendingInstaller(dir, { version: release!.version, file })
        keepStage = true
      }
      // From here the answer is "restart to finish", whatever else happens.
      installed = release!.version
      log(`${strategy === 'bundle' ? 'installed' : 'staged the installer for'} ${installed}; restart to finish`)
      onEvent({ type: 'done', ok: true, version: installed })
      return { version: installed }
    } catch (err) {
      // Anything not already an UpdateError is unexpected (an fs error, a custom `apply` that
      // threw) and its message is raw: paths inside the install, errno codes. The user gets a
      // sentence; the original goes in `cause`, which the log line below prints.
      const update =
        err instanceof UpdateError
          ? err
          : signal?.aborted
            ? new UpdateError('cancelled', 'The update was cancelled.', { cause: err })
            : new UpdateError('swap_failed', 'The update failed. Try again, or download the update instead.', { cause: err })
      warn(`install failed (${update.code}): ${update.message}${update.cause ? ` — ${errorText(update.cause)}` : ''}`)
      onEvent({ type: 'done', ok: false, code: update.code, message: update.message })
      throw update
    } finally {
      if (owned) {
        installing = false
        if (!keepStage) removeQuietly(dir)
      }
    }
  }

  const defaultApply: NonNullable<UpdaterConfig['apply']> = (file, tgt, onEvent, signal) =>
    applyBundleUpdate(file, tgt, {
      appName: config.appName,
      bundleExecutable: config.bundleExecutable ?? path.basename(tgt.executable),
      signal,
      onSwapping: () => onEvent({ type: 'swapping' }),
    })

  /** For staged downloads: a file a scanner still holds must not replace the install's own outcome. */
  const removeQuietly = (p: string): void => {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch (err) {
      warn(`could not remove ${p}: ${errorText(err)}`)
    }
  }

  return {
    check,
    install,
    installedVersion: () => installed,
    installing: () => installing,
    target: () => target,
    relaunch: () => finishUpdate({ target, appName: config.appName, relaunch: true, installer: config.installer, downloadDir: config.downloadDir, platform, log: warn }),
    cleanUp: () => {
      if (installing || installed) return
      cleanUpAfterUpdate(target, { appName: config.appName, downloadDir: config.downloadDir })
    },
    lastRelease: () => lastRelease,
  }
}

const UNREACHABLE = 'The release feed could not be reached. Check your connection and try again.'

const osName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform === 'darwin' ? 'macOS' : platform)

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * `promise`, or a `cancelled` rejection as soon as `signal` fires, whichever comes first. The
 * work behind `promise` is not stopped: others may be waiting on it.
 */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  const cancelled = () => new UpdateError('cancelled', 'The update was cancelled.')
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
