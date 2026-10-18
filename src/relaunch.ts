/**
 * Finishing an update as the app quits, and the handshake that lets the new copy take over.
 *
 * Two ways an update finishes, by platform:
 *
 *   macOS    the new bundle is already in place (swap-bundle.ts); the old process starts it with
 *            `--wait-for=<pid>` and exits. The new one waits for that pid to be gone before doing
 *            anything else, so the port the old one held is free by the time its server binds —
 *            and with it the page's origin, where the browser storage lives. Started any other
 *            way, the two would race for the port and the new one would fall back to a random
 *            one and come up with an empty localStorage.
 *   Windows  nothing has been replaced yet. The verified installer was staged by install(), and
 *            the old process starts it as it exits; the app's `InstallerHandoff` tells it to
 *            wait for this pid, install over the app unattended, and start it again. The
 *            installer waits, so the port is free the same way.
 *
 * `finishUpdate` is the one call that does whichever applies; the app awaits it after its window
 * closes, whether the user asked for the restart or just closed the app.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { STAGING_PID, stagingFor } from './swap-bundle'
import type { InstallTarget } from './target'

export const WAIT_FOR_FLAG = '--wait-for='

/** The pid a `--wait-for=` argument names, or null when there is none. */
export function waitForArg(argv: string[] = process.argv): number | null {
  const raw = argv.find((a) => a.startsWith(WAIT_FOR_FLAG))?.slice(WAIT_FOR_FLAG.length)
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** Whether process `pid` is running. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Wait (up to `timeoutMs`) for process `pid` to exit. Returns at once for one that isn't running. */
export async function waitForExit(pid: number, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until && isAlive(pid)) await Bun.sleep(100)
}

export interface RelaunchOptions {
  platform?: NodeJS.Platform
  pid?: number
  /** Further arguments for the new process. */
  args?: string[]
  log?: (line: string) => void
  /** macOS: how long to wait for `open` to answer before taking it as having worked. */
  openTimeoutMs?: number
}

/**
 * Start the copy now at the install path, detached, telling it to wait for this process.
 *
 * macOS goes through `open -n`: a fresh instance even while this one is still running, started
 * as an app (owned by launchd, responsible for its own permission prompts) rather than as a
 * child of a process that is about to exit. `--args` hands the flag through. If `open` cannot
 * (a stale Launch Services record after the swap), the executable is spawned directly.
 *
 * AWAIT IT BEFORE EXITING. Whether `open` worked is only known when it exits, and a process that
 * quits first never finds out, so the fallback never runs. The promise settles once the new copy
 * has been started one way or the other (or `open` is still busy after `openTimeoutMs`, which is
 * taken as working), and never rejects.
 */
export function relaunch(target: InstallTarget, opts: RelaunchOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform
  const args = [`${WAIT_FOR_FLAG}${opts.pid ?? process.pid}`, ...(opts.args ?? [])]
  const direct = () => start(target.executable, args, opts.log)
  if (platform !== 'darwin' || target.layout !== 'bundle') return direct().then(() => {})
  return new Promise<void>((resolve) => {
    // `error` and `exit` can both fire for one failure; the copy is started once.
    let settled = false
    const settle = (fallback: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!fallback) return resolve()
      opts.log?.(`${fallback}; starting ${target.executable} directly`)
      void direct().then(() => resolve())
    }
    const child = spawn('open', ['-n', target.path, '--args', ...args], { detached: true, stdio: 'ignore' })
    child.on('exit', (code) => settle(code === 0 ? null : `open exited with ${code}`))
    child.on('error', (err) => settle(`open could not run (${err.message})`))
    const timer = setTimeout(() => settle(null), opts.openTimeoutMs ?? 10_000)
  })
}

/**
 * Start `file` detached and resolve once it has started (true) or could not be (false, logged).
 * Not windowsHide: Windows applies SW_HIDE to a new process's first ShowWindow, which would be
 * the new app's main window (or the installer's progress window). Detached, it gets no console
 * window to hide anyway.
 */
function start(file: string, args: string[], log?: (line: string) => void): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('spawn', () => settle(true))
    child.on('error', (err) => {
      log?.(`could not start ${file}: ${err.message}`)
      settle(false)
    })
    child.unref()
    // A runtime that never reports `spawn` must not hold the app open; started is the likely answer.
    const timer = setTimeout(() => settle(true), 3_000)
  })
}

/** How an app runs its own installer unattended, for the platforms whose update is one (Windows). */
export interface InstallerHandoff {
  /**
   * The installer's arguments: install into `installDir` without asking anything, wait for
   * process `pid` (the app, quitting) to be gone first, and start the app again afterwards when
   * `relaunch` is set — the user pressed Restart rather than closing the app.
   */
  args(ctx: { installDir: string; pid: number; relaunch: boolean }): string[]
}

/** Where install() keeps this process's download: one folder per process, so two copies of the app never share one. */
export function stageDir(appName: string, opts: { pid?: number; downloadDir?: string } = {}): string {
  return path.join(opts.downloadDir ?? os.tmpdir(), `${stagePrefix(appName)}${opts.pid ?? process.pid}`)
}
const stagePrefix = (appName: string) => `${appName.toLowerCase()}-update-`
const PENDING = 'pending.json'

/** A verified installer install() staged, waiting for the app to quit. */
export interface PendingInstaller {
  version: string
  /** The installer's path. */
  file: string
}

export function writePendingInstaller(dir: string, pending: PendingInstaller): void {
  fs.writeFileSync(path.join(dir, PENDING), JSON.stringify(pending))
}

/** The installer this process staged, or null. */
export function pendingInstaller(appName: string, opts: { pid?: number; downloadDir?: string } = {}): PendingInstaller | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stageDir(appName, opts), PENDING), 'utf8')) as Partial<PendingInstaller>
    return typeof raw.version === 'string' && typeof raw.file === 'string' && fs.existsSync(raw.file) ? { version: raw.version, file: raw.file } : null
  } catch {
    return null
  }
}

export interface FinishOptions {
  /** The running app's install (`installTarget()`); null when running from source. */
  target: InstallTarget | null
  appName: string
  /** The user asked for a restart (rather than closing the app). */
  relaunch: boolean
  /** Windows: how to run the installer install() staged. */
  installer?: InstallerHandoff
  /** Where install() staged its download, when the updater was given a `downloadDir`. */
  downloadDir?: string
  platform?: NodeJS.Platform
  log?: (line: string) => void
}

/**
 * Finish whatever update this process installed, as it quits. Await it before exiting.
 *
 * A staged installer (Windows) runs whether or not the user asked for the restart: an update
 * the user started finishes when they close the app, and only the relaunch depends on the ask.
 * If the installer cannot be started, the app is started again as it is (nothing was replaced),
 * so a Restart never ends with no app. Otherwise, on a restart, the new copy is started.
 */
export async function finishUpdate(opts: FinishOptions): Promise<void> {
  const { target, log } = opts
  if (!target) return
  const pending = opts.installer ? pendingInstaller(opts.appName, { downloadDir: opts.downloadDir }) : null
  if (pending && opts.installer) {
    const args = opts.installer.args({ installDir: target.path, pid: process.pid, relaunch: opts.relaunch })
    log?.(`starting the ${pending.version} installer`)
    if (await start(pending.file, args, log)) return
  }
  if (opts.relaunch) await relaunch(target, { platform: opts.platform, log })
}

export interface CleanUpOptions {
  /** Removes other processes' staged downloads (`stageDir`) once their process is gone. */
  appName?: string
  downloadDir?: string
}

/**
 * Remove what an update left behind: a bundle copy staged beside the app and never swapped in,
 * the previous bundle a swap could not delete while it ran, and the downloads of processes that
 * have since exited (a Windows installer ran from one moments ago). Called at every launch;
 * swallows "still in use", which the next launch will see again.
 *
 * Never what ANOTHER running copy of the app is in the middle of: a staging folder whose `.pid`
 * names a live process, or a download folder of one.
 */
export function cleanUpAfterUpdate(target: InstallTarget | null, opts: CleanUpOptions = {}): void {
  const leftovers: string[] = []
  if (target?.layout === 'bundle') {
    const staging = stagingFor(target.path)
    if (!ownedByOtherLiveProcess(staging)) leftovers.push(staging)
  }
  if (opts.appName) {
    const dir = opts.downloadDir ?? os.tmpdir()
    const prefix = stagePrefix(opts.appName)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix))
    } catch {
      // No temp directory to read: nothing staged there.
    }
    for (const name of names) {
      const pid = Number(name.slice(prefix.length))
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isAlive(pid)) leftovers.push(path.join(dir, name))
    }
  }
  for (const p of leftovers) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      // Still in use; the next launch tries again.
    }
  }
}

function ownedByOtherLiveProcess(staging: string): boolean {
  try {
    const pid = Number(fs.readFileSync(path.join(staging, STAGING_PID), 'utf8'))
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)
  } catch {
    return false
  }
}
