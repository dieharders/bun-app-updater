/**
 * The bundle layout's swap: macOS, where the app is a sealed `.app`.
 *
 * The archive holds the whole bundle, made by `ditto` on the build machine, so `ditto` unpacks
 * it: symlinks, modes and the code signature come out exactly as they went in. The bundle is
 * then verified with `codesign` — a broken seal would otherwise only show up as "<App> is
 * damaged and can't be opened" on the next launch — and swapped in by rename, beside the old
 * one. A running app's bundle can be renamed and even deleted on macOS, so there is nothing to
 * clean up on the next launch.
 */
import fs from 'node:fs'
import path from 'node:path'
import { UpdateError } from './errors'
import type { InstallTarget } from './target'

export interface BundleSwapOptions {
  signal?: AbortSignal
  onSwapping?: () => void
  appName: string
  /** The executable's name under Contents/MacOS, to recognise the bundle in the archive. */
  bundleExecutable: string
  /** Set false only in tests of unsigned bundles. */
  verifySignature?: boolean
  /** Injectable for the rollback test; defaults to fs.renameSync. */
  rename?: (from: string, to: string) => void
}

export async function applyBundleUpdate(zipPath: string, target: InstallTarget, opts: BundleSwapOptions): Promise<void> {
  const app = target.path
  const fresh = `${app}.new`
  const old = `${app}.old`
  const rename = opts.rename ?? fs.renameSync

  // An earlier swap that could not put the app back left it only at `.old`. That is the user's
  // one copy, and the swap below starts by removing `.old`, so it goes back first.
  if (!fs.existsSync(app) && fs.existsSync(old)) {
    try {
      rename(old, app)
    } catch (err) {
      throw new UpdateError('swap_failed', putBackMessage(opts.appName, app, old), { cause: err })
    }
  }

  fs.rmSync(fresh, { recursive: true, force: true })
  let incoming: string
  try {
    // Made here rather than by ditto, so a folder the app can't write to fails with EACCES
    // rather than ditto's "Permission denied" text.
    fs.mkdirSync(fresh)
    await run(['ditto', '-x', '-k', zipPath, fresh], "The update's download couldn't be unpacked", 'unpack_failed')
    const apps = fs.readdirSync(fresh).filter((name) => name.endsWith('.app'))
    const found = apps.length === 1 ? path.join(fresh, apps[0]!) : null
    if (!found || !fs.existsSync(path.join(found, 'Contents', 'MacOS', opts.bundleExecutable))) {
      throw new UpdateError('damaged', `The update's download has no ${opts.appName} app in it.`)
    }
    if (opts.verifySignature !== false) {
      await run(['codesign', '--verify', '--deep', '--strict', found], "The update's signature doesn't check out", 'damaged')
    }
    // fetch() attaches no quarantine attribute, but a bundle that somehow carries one would be
    // refused by Gatekeeper on relaunch, so it is stripped anyway.
    await run(['xattr', '-dr', 'com.apple.quarantine', found], '', 'unpack_failed').catch(() => {})
    incoming = found
  } catch (err) {
    fs.rmSync(fresh, { recursive: true, force: true })
    if (err instanceof UpdateError) throw err
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      throw new UpdateError('swap_failed', `${opts.appName} can't replace itself where it's installed. Download the update instead.`, { cause: err })
    }
    throw new UpdateError('unpack_failed', "The update's download couldn't be unpacked.", { cause: err })
  }

  opts.onSwapping?.()
  if (opts.signal?.aborted) {
    fs.rmSync(fresh, { recursive: true, force: true })
    throw new UpdateError('cancelled', 'The update was cancelled.')
  }

  try {
    fs.rmSync(old, { recursive: true, force: true })
    rename(app, old)
  } catch (err) {
    fs.rmSync(fresh, { recursive: true, force: true })
    throw new UpdateError('swap_failed', `${opts.appName} can't replace itself where it's installed. Download the update instead.`, { cause: err })
  }
  try {
    rename(incoming, app)
  } catch (err) {
    removeQuietly(fresh)
    try {
      rename(old, app)
    } catch {
      // The app is now only at `.old`, which stays: the next launch or install puts it back.
      throw new UpdateError('swap_failed', putBackMessage(opts.appName, app, old), { cause: err })
    }
    throw new UpdateError('swap_failed', `${opts.appName} couldn't swap the update in.`, { cause: err })
  }
  // The update is in place: what is left is cleanup, and cleanUpAfterUpdate retries it.
  removeQuietly(fresh)
  removeQuietly(old)
}

const putBackMessage = (appName: string, app: string, old: string): string =>
  `${appName} couldn't swap the update in or put itself back. In the folder ${appName} was in, rename ${path.basename(old)} to ${path.basename(app)}.`

const removeQuietly = (p: string): void => {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    // Still held; cleanUpAfterUpdate tries again at the next launch.
  }
}

/**
 * Run a macOS tool. When it fails, throws `message`, which the user sees; what the tool said goes
 * in `cause`, for the log. Its stderr names paths inside the install and reads as a crash report.
 */
async function run(cmd: string[], message: string, code: 'unpack_failed' | 'damaged'): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'pipe' })
  const [err, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (exit !== 0) throw new UpdateError(code, `${message}.`, { cause: new Error(`${path.basename(cmd[0]!)} exited ${exit}: ${err.trim()}`) })
}
