/**
 * The bundle layout's swap: macOS, where the app is a sealed `.app`.
 *
 * The release's download for macOS is the DMG a person installs from. It is mounted read-only,
 * and the `.app` on it is copied out beside the installed one with `ditto`, so symlinks, modes
 * and the code signature come out exactly as they were built. The copy is verified with
 * `codesign` — a broken seal would otherwise only show up as "<App> is damaged and can't be
 * opened" on the next launch — and then EXCHANGED with the installed bundle in one step
 * (`renamex_np` with RENAME_SWAP). There is no moment at which the folder holds no app, so
 * nothing an interruption could leave half done. A running app's bundle can be swapped and
 * deleted on macOS.
 *
 * The copy is staged at `<App>.app.new`, which holds a `.pid` file naming the process that made
 * it, so a second copy of the app launching meanwhile leaves it alone (see cleanUpAfterUpdate).
 */
import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UpdateError } from './errors'
import type { InstallTarget } from './target'

export interface BundleSwapOptions {
  signal?: AbortSignal
  onSwapping?: () => void
  appName: string
  /** The executable's name under Contents/MacOS, to recognise the bundle on the disk image. */
  bundleExecutable: string
  /** Set false only in tests of unsigned bundles. */
  verifySignature?: boolean
  /** Injectable for the failure test; defaults to an atomic exchange (`exchangePaths`). */
  exchange?: (a: string, b: string) => void
}

/** Where a bundle update is staged, beside the installed `.app`. */
export const stagingFor = (app: string): string => `${app}.new`
/** The file in the staging folder naming the process that is filling it. */
export const STAGING_PID = '.pid'

export async function applyBundleUpdate(dmgPath: string, target: InstallTarget, opts: BundleSwapOptions): Promise<void> {
  const app = target.path
  const staging = stagingFor(app)
  const exchange = opts.exchange ?? exchangePaths
  const cantReplace = (cause: unknown) =>
    new UpdateError('swap_failed', `${opts.appName} can't replace itself where it's installed. Download the update instead.`, { cause })

  let incoming = ''
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), `${opts.appName.toLowerCase()}-update-mount-`))
  try {
    fs.rmSync(staging, { recursive: true, force: true })
    // Made here rather than by ditto, so a folder the app can't write to fails with EACCES
    // rather than ditto's "Permission denied" text.
    fs.mkdirSync(staging)
    fs.writeFileSync(path.join(staging, STAGING_PID), String(process.pid))
    await run(['hdiutil', 'attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmgPath], "The update's download couldn't be opened", 'unpack_failed')
    try {
      const apps = fs.readdirSync(mount).filter((name) => name.endsWith('.app'))
      const found = apps.length === 1 ? apps[0]! : null
      if (!found || !fs.existsSync(path.join(mount, found, 'Contents', 'MacOS', opts.bundleExecutable))) {
        throw new UpdateError('damaged', `The update's download has no ${opts.appName} app in it.`)
      }
      if (opts.signal?.aborted) throw new UpdateError('cancelled', 'The update was cancelled.')
      incoming = path.join(staging, found)
      await run(['ditto', path.join(mount, found), incoming], "The update couldn't be copied out of its download", 'unpack_failed')
    } finally {
      await detach(mount)
    }
    if (opts.verifySignature !== false) {
      await run(['codesign', '--verify', '--deep', '--strict', incoming], "The update's signature doesn't check out", 'damaged')
    }
    // fetch() attaches no quarantine attribute, but a bundle that somehow carries one would be
    // refused by Gatekeeper on relaunch, so it is stripped anyway.
    await run(['xattr', '-dr', 'com.apple.quarantine', incoming], '', 'unpack_failed').catch(() => {})
  } catch (err) {
    removeQuietly(staging)
    if (err instanceof UpdateError) throw err
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') throw cantReplace(err)
    throw new UpdateError('unpack_failed', "The update's download couldn't be unpacked.", { cause: err })
  } finally {
    removeQuietly(mount)
  }

  opts.onSwapping?.()
  if (opts.signal?.aborted) {
    removeQuietly(staging)
    throw new UpdateError('cancelled', 'The update was cancelled.')
  }
  try {
    exchange(incoming, app)
  } catch (err) {
    // Nothing moved: the exchange is one step, so a failure leaves the app where it was.
    removeQuietly(staging)
    throw cantReplace(err)
  }
  // `incoming` now holds the previous bundle. What is left is cleanup, and cleanUpAfterUpdate
  // retries it at the next launch.
  removeQuietly(staging)
}

const RENAME_SWAP = 0x2
let libSystem: ReturnType<typeof openLibSystem> | null = null
const openLibSystem = () =>
  dlopen('/usr/lib/libSystem.B.dylib', {
    renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  })

/**
 * Exchange two paths on one volume atomically (macOS, APFS and HFS+). Throws, with nothing
 * moved, where the volume cannot (an exFAT drive, a network share).
 */
export function exchangePaths(a: string, b: string): void {
  libSystem ??= openLibSystem()
  const ca = Buffer.from(`${a}\0`)
  const cb = Buffer.from(`${b}\0`)
  if (libSystem.symbols.renamex_np(ptr(ca), ptr(cb), RENAME_SWAP) !== 0) {
    const where = libSystem.symbols.__error()
    const errno = where ? read.i32(where, 0) : -1
    throw Object.assign(new Error(`renamex_np(RENAME_SWAP) failed with errno ${errno}`), { errno })
  }
}

async function detach(mount: string): Promise<void> {
  // A disk image still busy (Spotlight indexing it, say) refuses a plain detach.
  for (const force of [false, true]) {
    const proc = Bun.spawn(['hdiutil', 'detach', ...(force ? ['-force'] : []), mount], { stdout: 'ignore', stderr: 'ignore' })
    if ((await proc.exited) === 0) return
  }
}

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
