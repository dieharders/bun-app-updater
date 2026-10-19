/**
 * What an update replaces, and whether this copy of the app can replace it.
 *
 * Two layouts, because two kinds of install exist:
 *
 *   bundle     macOS. The executable sits in `<Name>.app/Contents/MacOS/`, and the bundle is
 *              codesigned as a whole, so the smallest thing that can be replaced without
 *              breaking the seal is the whole `.app`. The target is the bundle.
 *   directory  Windows and Linux. The executable sits in a directory with whatever the build
 *              staged beside it (a vendored toolchain, assets). The target is that directory;
 *              on Windows the app's installer is run into it as the app quits.
 *
 * Running from source — `bun run main.ts`, where the executable is Bun itself — has no target.
 * An update then has nothing to replace, and the UI offers the download page instead.
 */
import fs from 'node:fs'
import path from 'node:path'

export type Layout = 'bundle' | 'directory'

export interface InstallTarget {
  layout: Layout
  /** The `.app` for a bundle; the install directory otherwise. */
  path: string
  /** The running executable, absolute. */
  executable: string
}

export interface TargetOptions {
  execPath?: string
  platform?: NodeJS.Platform
}

export function installTarget(opts: TargetOptions = {}): InstallTarget | null {
  const execPath = opts.execPath ?? process.execPath
  const platform = opts.platform ?? process.platform
  // By `platform`'s rules, not the host's: POSIX basename does not split on `\`. And by name alone:
  // `resolve` would make a path absolute against THIS process's working directory, so a macOS
  // path checked on a Windows host (the tests) came out as `<cwd>/C:/…` and never a bundle.
  const p = platform === 'win32' ? path.win32 : path.posix
  const name = p.basename(execPath)
  if (/^bun(\.exe)?$/i.test(name)) return null
  if (platform === 'darwin') {
    const app = p.dirname(p.dirname(p.dirname(execPath)))
    return app.endsWith('.app') ? { layout: 'bundle', path: app, executable: execPath } : null
  }
  return { layout: 'directory', path: p.dirname(execPath), executable: execPath }
}

export interface BlockedOptions {
  platform?: NodeJS.Platform
  /** For the messages: "<appName> can't write to the folder it's in." */
  appName: string
  /** Bytes the update will need on the target's volume (download + unpacked + the old copy). */
  needBytes?: number
}

/**
 * Why an in-place update is impossible here, or null when it is not. Checked before offering
 * the update, so the UI shows "Download" instead of a button that fails.
 *
 * The write check writes a real file. On Windows `fs.access` reads the read-only flag and not
 * the folder's ACL, so it would pass Program Files; a write is the only question that gets the
 * right answer everywhere.
 */
export function blockedReason(target: InstallTarget | null, opts: BlockedOptions): string | null {
  const platform = opts.platform ?? process.platform
  if (!target) return `${opts.appName} is running from source, so there is nothing to update in place.`
  // macOS runs an app opened straight from where it was downloaded from a hidden read-only
  // copy (App Translocation). Only the user moving it ends that.
  if (platform === 'darwin' && target.path.includes('/AppTranslocation/')) {
    return `Move ${opts.appName} to your Applications folder to update it in place.`
  }
  // Where the swap writes: beside the bundle, or inside the directory.
  const dir = target.layout === 'bundle' ? path.dirname(target.path) : target.path
  const probe = path.join(dir, `.${opts.appName.toLowerCase()}-write-test-${process.pid}`)
  try {
    fs.writeFileSync(probe, '')
    fs.rmSync(probe)
  } catch {
    return `${opts.appName} can't write to the folder it's in, so it can't update itself. Download the update instead.`
  }
  if (opts.needBytes && opts.needBytes > 0) {
    const free = freeBytes(dir)
    if (free !== null && free < opts.needBytes) {
      return `There isn't enough free disk space to update (${mb(opts.needBytes)} needed, ${mb(free)} free).`
    }
  }
  return null
}

const mb = (n: number) => `${Math.ceil(n / 1024 / 1024)} MB`

/** Free bytes on the volume holding `dir`, or null where the runtime cannot say. */
export function freeBytes(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

/** This build's platform name in release downloads: `windows-x64`, `darwin-arm64`, `linux-x64`. */
export function targetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform === 'win32' ? 'windows' : platform}-${arch}`
}
