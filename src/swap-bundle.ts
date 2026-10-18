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
}

export async function applyBundleUpdate(zipPath: string, target: InstallTarget, opts: BundleSwapOptions): Promise<void> {
  const app = target.path
  const fresh = `${app}.new`
  const old = `${app}.old`

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
    fs.renameSync(app, old)
  } catch (err) {
    fs.rmSync(fresh, { recursive: true, force: true })
    throw new UpdateError('swap_failed', `${opts.appName} can't replace itself where it's installed. Download the update instead.`, { cause: err })
  }
  try {
    fs.renameSync(incoming, app)
  } catch (err) {
    fs.renameSync(old, app)
    fs.rmSync(fresh, { recursive: true, force: true })
    throw new UpdateError('swap_failed', `${opts.appName} couldn't swap the update in.`, { cause: err })
  }
  fs.rmSync(fresh, { recursive: true, force: true })
  fs.rmSync(old, { recursive: true, force: true })
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
