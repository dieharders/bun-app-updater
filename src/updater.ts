/**
 * The updater an app talks to: one object made from one config.
 *
 *   check()    what the feed offers, from this build's point of view, with a cache so however
 *              often a page asks, the feed is asked at most once per TTL.
 *   install()  download, verify, unpack, swap — reporting each step — then remember that the
 *              new version is in place, waiting for a restart.
 *   relaunch() start the new copy; the app calls this as it quits.
 *
 * A release is read through its MANIFEST (manifest.ts): one asset naming a zip per top-level
 * entry of the install, each with a content hash. The updater hashes the installed entries and
 * downloads only the parts whose content differs — on a typical release that is the executable
 * and a few small folders, not the vendored toolchain. The plan (which parts, how many bytes)
 * is made once per release version and reused by `check()` and `install()`.
 *
 * Nothing here knows how the app is served, drawn or stopped. The app supplies `busy()` (why an
 * install must wait: a job in flight, a child process alive) and reads events; the HTTP shape
 * is in http.ts for apps that want it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadTo } from './download'
import { type InstallErrorCode, UpdateError, isAbort } from './errors'
import { type UpdateManifest, type UpdatePart, parseManifest } from './manifest'
import { cleanUpAfterUpdate, relaunch as relaunchTarget } from './relaunch'
import { ReleaseFeedError, type Release, type ReleaseAsset, type ReleaseSource } from './source'
import { applyBundleUpdate } from './swap-bundle'
import { applyDirectoryUpdate } from './swap-directory'
import { type InstallTarget, blockedReason, installTarget, targetName } from './target'
import { hashTree } from './tree-hash'
import { compareVersions } from './version'

export interface UpdaterConfig {
  /** For messages: "<appName> can't write to the folder it's in." */
  appName: string
  /** The running build's version, strict `X.Y.Z`. */
  version: string
  source: ReleaseSource
  /** The manifest's file name in a release, e.g. `(v, t) => \`MyApp-${v}-${t}.manifest.json\``. */
  manifestName: (version: string, target: string) => string
  platform?: NodeJS.Platform
  arch?: string
  execPath?: string
  /** macOS: the executable's name under Contents/MacOS. Defaults to the running one's. */
  bundleExecutable?: string
  /** Why an install must wait right now (a job running, a child process alive), or null. */
  busy?: () => string | null
  /** How long a check's answer is reused. Default 30 minutes. */
  checkTtlMs?: number
  /** Where the download is staged. Default: the OS temp directory. */
  downloadDir?: string
  hooks?: {
    /** After the new files are in place and before the install is reported done. */
    afterSwap?: (ctx: { version: string; target: InstallTarget }) => Promise<void> | void
  }
  log?: (line: string) => void
  /** Test seam: replaces the real swap. One zip per part, in the manifest's order. */
  apply?: (zipPaths: string[], parts: UpdatePart[], target: InstallTarget, events: InstallEventSink) => Promise<void>
}

/** What `check()` answers. */
export interface UpdateInfo {
  current: string
  /** This build's platform name, as the release's downloads name it. */
  target: string
  /**
   * A newer published release WITH an update for this target, or null. `size` is what an
   * install would download: the parts whose content differs from what is installed. 0 when
   * that could not be worked out yet (the install reports why).
   */
  latest: { version: string; url: string; size: number; parts: string[] } | null
  /** The version already swapped in, waiting for a restart; null when none is. */
  installed: string | null
  /** Why an in-place install is impossible here, so the UI offers the download page; null when it can. */
  blocked: string | null
}

export type InstallEvent =
  | { type: 'checking' }
  | { type: 'downloading'; received: number; total: number }
  | { type: 'verifying' }
  | { type: 'unpacking'; done: number; total: number }
  | { type: 'swapping' }
  | { type: 'done'; ok: true; version: string }
  | { type: 'done'; ok: false; code: InstallErrorCode; message: string }

export type InstallEventSink = (event: InstallEvent) => void

export interface Updater {
  check(opts?: { force?: boolean; signal?: AbortSignal }): Promise<UpdateInfo>
  install(opts: { onEvent: InstallEventSink; signal?: AbortSignal }): Promise<{ version: string }>
  /** The version swapped in by install(), or null. */
  installedVersion(): string | null
  /** Whether an install is between download and swap right now. */
  installing(): boolean
  target(): InstallTarget | null
  /** Start the copy now at the install path; call as the app quits. */
  relaunch(): void
  /** Remove a previous update's leftovers; call at launch. */
  cleanUp(): void
  /** The release the last check found, newer or not. */
  lastRelease(): Release | null
}

/** A release read through its manifest, against this install: what to download. */
interface Plan {
  manifest: UpdateManifest
  /** The parts whose content differs from what is installed (all of them for a bundle). */
  needed: UpdatePart[]
  /** Where each part's asset is downloaded from, by part name. */
  urls: Map<string, string>
  bytes: number
}

const DEFAULT_TTL = 30 * 60_000
/** Even a forced check waits this long after the previous one: the feed is shared with everything else on this address. */
const FORCE_FLOOR = 60_000

export function createUpdater(config: UpdaterConfig): Updater {
  const platform = config.platform ?? process.platform
  const arch = config.arch ?? process.arch
  const target = installTarget({ execPath: config.execPath, platform })
  const targetId = targetName(platform, arch)
  const ttl = config.checkTtlMs ?? DEFAULT_TTL
  const log = config.log ?? (() => {})
  const downloadDir = () => config.downloadDir ?? os.tmpdir()
  const stagePath = (suffix: string) => path.join(downloadDir(), `${config.appName.toLowerCase()}-update-${process.pid}-${suffix}`)

  let installed: string | null = null
  let installing = false
  let lastCheck: { at: number; release: Promise<Release | null>; failed: boolean } | null = null
  let lastRelease: Release | null = null
  /** One plan per release version; dropped after a swap, when the installed hashes change. */
  let plans: { version: string; plan: Promise<Plan> } | null = null

  const manifestAssetFor = (release: Release): ReleaseAsset | null => {
    const name = config.manifestName(release.version, targetId)
    return release.assets.find((a) => a.name === name) ?? null
  }
  const isNewer = (release: Release | null): release is Release => !!release && compareVersions(release.version, config.version) > 0

  /** Fetch and verify the manifest, hash the install, decide what to download. */
  const makePlan = async (release: Release, signal?: AbortSignal): Promise<Plan> => {
    const asset = manifestAssetFor(release)!
    const file = stagePath(`${release.version}.manifest.json`)
    let raw: unknown
    try {
      await downloadTo(asset.url, file, { size: asset.size, sha256: asset.sha256 ?? '', signal })
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      if (err instanceof UpdateError) throw err
      throw new UpdateError('damaged', "The release's update manifest isn't valid JSON.", { cause: err })
    } finally {
      fs.rmSync(file, { force: true })
    }
    const manifest = parseManifest(raw, { version: release.version, target: targetId })
    const urls = new Map<string, string>()
    for (const part of manifest.parts) {
      const listed = release.assets.find((a) => a.name === part.asset)
      if (!listed) throw new UpdateError('damaged', `The release has no ${part.asset}, which its manifest lists for ${part.name}.`)
      // The manifest's checksum is what the download is checked against (the feed vouched for
      // the manifest). When the feed lists one too, the two must agree.
      if (listed.sha256 && listed.sha256 !== part.sha256) throw new UpdateError('damaged', `The release feed and the manifest disagree about ${part.asset}'s checksum.`)
      urls.set(part.name, listed.url)
    }
    let needed: UpdatePart[]
    if (!target || target.layout === 'bundle') {
      needed = manifest.parts
    } else {
      const exeName = path.basename(target.executable)
      if (!manifest.parts.some((p) => p.name === exeName)) {
        throw new UpdateError('damaged', `The release isn't a ${config.appName} build (no ${exeName} in it).`)
      }
      needed = []
      for (const part of manifest.parts) {
        const here = await hashTree(path.join(target.path, part.name), { signal })
        if (here !== part.tree) needed.push(part)
      }
    }
    const bytes = needed.reduce((n, p) => n + p.size, 0)
    log(`${release.version}: ${needed.length} of ${manifest.parts.length} parts to download (${needed.map((p) => p.name).join(', ') || 'none'}; ${Math.ceil(bytes / 1048576)} MB)`)
    return { manifest, needed, urls, bytes }
  }

  const planFor = (release: Release, signal?: AbortSignal): Promise<Plan> => {
    if (plans?.version !== release.version) {
      const plan = makePlan(release, signal)
      const entry = { version: release.version, plan }
      plans = entry
      // A failed plan is not kept: the next ask tries again (the feed may have been fixed).
      plan.catch(() => {
        if (plans === entry) plans = null
      })
    }
    return plans.plan
  }

  const describe = async (release: Release | null, blocked: string | null, signal?: AbortSignal): Promise<UpdateInfo> => {
    const asset = isNewer(release) ? manifestAssetFor(release) : null
    let latest: UpdateInfo['latest'] = null
    let need = 0
    if (release && asset) {
      latest = { version: release.version, url: release.url, size: 0, parts: [] }
      try {
        const plan = await planFor(release, signal)
        latest.size = plan.bytes
        latest.parts = plan.needed.map((p) => p.name)
        need = plan.bytes * 3
      } catch (err) {
        // Still offered: the install says what is wrong with it, in words.
        log(`could not plan ${release.version}: ${(err as Error).message}`)
      }
    }
    return {
      current: config.version,
      target: targetId,
      latest,
      installed,
      blocked: blocked ?? blockedReason(target, { platform, appName: config.appName, needBytes: need }),
    }
  }

  const fetchRelease = async (signal?: AbortSignal): Promise<Release | null> => {
    const release = await config.source.latest(signal)
    lastRelease = release
    return release
  }

  const check: Updater['check'] = async (opts = {}) => {
    if (installed) return describe(null, blockedReason(target, { platform, appName: config.appName }))
    const age = lastCheck ? Date.now() - lastCheck.at : Infinity
    // A forced check (the user clicked) may ask again sooner than the TTL, but not sooner than
    // the floor — unless the last answer was a failure, which is exactly what a click retries.
    const stale = age > ttl || (opts.force && (lastCheck?.failed || age > FORCE_FLOOR))
    if (!lastCheck || stale) {
      // Offline, or the feed is down: no update to offer, and nothing worth telling the user
      // from a background check. A forced check surfaces the reason.
      const release = fetchRelease(opts.signal)
      const entry = { at: Date.now(), release: release.catch(() => null), failed: false }
      release.catch(() => (entry.failed = true))
      lastCheck = entry
      if (opts.force) await release
    }
    const release = await lastCheck.release
    return describe(release, null, opts.signal)
  }

  const install: Updater['install'] = async ({ onEvent, signal }) => {
    const fail = (code: InstallErrorCode, message: string, cause?: unknown): never => {
      throw new UpdateError(code, message, { cause })
    }
    const zipPaths: string[] = []
    let owned = false
    try {
      if (installed) fail('already_installed', `${config.appName} ${installed} is already installed. Restart ${config.appName} to finish.`)
      if (installing) fail('in_progress', 'An update is already being installed.')
      installing = true
      owned = true
      const busy = config.busy?.()
      if (busy) fail('busy', `${config.appName} can't update while ${busy}. Try again when it's finished.`)
      const blocked = blockedReason(target, { platform, appName: config.appName })
      if (blocked || !target) fail('blocked', blocked ?? `${config.appName} is running from source.`)

      onEvent({ type: 'checking' })
      let release: Release | null = null
      try {
        release = await fetchRelease(signal)
        lastCheck = { at: Date.now(), release: Promise.resolve(release), failed: false }
      } catch (err) {
        if (signal?.aborted || isAbort(err)) fail('cancelled', 'The update was cancelled.', err)
        const feed = err instanceof ReleaseFeedError ? err : null
        fail('offline', feed?.message ?? 'The release feed could not be reached. Check your connection and try again.', err)
      }
      if (!isNewer(release) || !manifestAssetFor(release)) fail('no_update', "There's no newer version to install.")
      const plan = await planFor(release!, signal)
      if (plan.needed.length === 0) fail('no_update', `Everything in ${config.appName} ${release!.version} is already in place. Restart ${config.appName}.`)
      const needBlocked = blockedReason(target, { platform, appName: config.appName, needBytes: plan.bytes * 3 })
      if (needBlocked) fail('blocked', needBlocked)

      onEvent({ type: 'downloading', received: 0, total: plan.bytes })
      let doneBefore = 0
      for (const part of plan.needed) {
        const zipPath = stagePath(`${release!.version}-${zipPaths.length}.zip`)
        zipPaths.push(zipPath)
        const url = plan.urls.get(part.name)!
        log(`downloading ${part.name} from ${url} -> ${zipPath}`)
        await downloadTo(url, zipPath, {
          size: part.size,
          sha256: part.sha256,
          signal,
          onProgress: (received) => onEvent({ type: 'downloading', received: doneBefore + received, total: plan.bytes }),
          onVerifying: () => onEvent({ type: 'verifying' }),
        })
        doneBefore += part.size
      }

      // Asked again: a job may have started during a long download, and the swap is the one
      // step that must not run under a process spawned from the files it moves.
      const busyNow = config.busy?.()
      if (busyNow) fail('busy', `${config.appName} can't update while ${busyNow}. Try again when it's finished.`)

      onEvent({ type: 'unpacking', done: 0, total: 1 })
      const apply = config.apply ?? defaultApply
      await apply(zipPaths, plan.needed, target!, onEvent)
      plans = null
      await config.hooks?.afterSwap?.({ version: release!.version, target: target! })
      installed = release!.version
      log(`installed ${installed}; restart to finish`)
      onEvent({ type: 'done', ok: true, version: installed })
      return { version: installed }
    } catch (err) {
      // Anything not already an UpdateError is unexpected (an fs error, a hook that threw) and its
      // message is raw: paths inside the install, errno codes. The user gets a sentence; the
      // original goes in `cause`, which the log line below prints.
      const update =
        err instanceof UpdateError
          ? err
          : signal?.aborted
            ? new UpdateError('cancelled', 'The update was cancelled.', { cause: err })
            : new UpdateError('swap_failed', 'The update failed. Try again, or download the update instead.', { cause: err })
      log(`install failed (${update.code}): ${update.message}${update.cause ? ` — ${String((update.cause as Error).message ?? update.cause)}` : ''}`)
      onEvent({ type: 'done', ok: false, code: update.code, message: update.message })
      throw update
    } finally {
      if (owned) installing = false
      for (const zipPath of zipPaths) fs.rmSync(zipPath, { force: true })
    }
  }

  const defaultApply: NonNullable<UpdaterConfig['apply']> = async (zips, parts, tgt, onEvent) => {
    if (tgt.layout === 'bundle') {
      if (zips.length !== 1) throw new UpdateError('damaged', `The release lists ${zips.length} parts for a ${config.appName} bundle; it must be one.`)
      await applyBundleUpdate(zips[0]!, tgt, {
        appName: config.appName,
        bundleExecutable: config.bundleExecutable ?? path.basename(tgt.executable),
        onSwapping: () => onEvent({ type: 'swapping' }),
      })
    } else {
      await applyDirectoryUpdate(zips, tgt, {
        appName: config.appName,
        platform,
        expect: parts.map((p) => p.name),
        onUnpackProgress: (done, total) => onEvent({ type: 'unpacking', done, total }),
        onSwapping: () => onEvent({ type: 'swapping' }),
      })
    }
  }

  return {
    check,
    install,
    installedVersion: () => installed,
    installing: () => installing,
    target: () => target,
    relaunch: () => {
      if (target) relaunchTarget(target, { platform, log })
    },
    cleanUp: () => cleanUpAfterUpdate(target),
    lastRelease: () => lastRelease,
  }
}
