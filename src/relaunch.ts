/**
 * Starting the new copy, and the handshake that lets it take over cleanly.
 *
 * The new process is started by the old one as it quits, with `--wait-for=<pid>`. It waits
 * for that pid to be gone before doing anything else, so the port the old one held is free by
 * the time its server binds — and with it the page's origin, where the browser storage lives.
 * Started any other way, the two would race for the port and the new one would fall back to a
 * random one and come up with an empty localStorage.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { NEW_DIR, OLD_DIR, restoreSetAside } from './swap-directory'
import type { InstallTarget } from './target'

export const WAIT_FOR_FLAG = '--wait-for='

/** The pid a `--wait-for=` argument names, or null when there is none. */
export function waitForArg(argv: string[] = process.argv): number | null {
  const raw = argv.find((a) => a.startsWith(WAIT_FOR_FLAG))?.slice(WAIT_FOR_FLAG.length)
  const pid = Number(raw)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** Wait (up to `timeoutMs`) for process `pid` to exit. Returns at once for one that isn't running. */
export async function waitForExit(pid: number, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await Bun.sleep(100)
  }
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
 * (a stale Launch Services record after the rename), the executable is spawned directly.
 *
 * AWAIT IT BEFORE EXITING. Whether `open` worked is only known when it exits, and a process that
 * quits first never finds out, so the fallback never runs. The promise settles once the new copy
 * has been started one way or the other (or `open` is still busy after `openTimeoutMs`, which is
 * taken as working), and never rejects. Elsewhere it settles at once.
 */
export function relaunch(target: InstallTarget, opts: RelaunchOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform
  const args = [`${WAIT_FOR_FLAG}${opts.pid ?? process.pid}`, ...(opts.args ?? [])]
  const direct = () => {
    // Not windowsHide: Windows applies SW_HIDE to a new process's first ShowWindow, which would
    // be the new app's main window. Detached, it gets no console window to hide anyway.
    const child = spawn(target.executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', (err) => opts.log?.(`could not start ${target.executable}: ${err.message}`))
    child.unref()
  }
  if (platform !== 'darwin' || target.layout !== 'bundle') {
    direct()
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    // `error` and `exit` can both fire for one failure; the copy is started once.
    let settled = false
    const settle = (fallback: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (fallback) {
        opts.log?.(`${fallback}; starting ${target.executable} directly`)
        direct()
      }
      resolve()
    }
    const child = spawn('open', ['-n', target.path, '--args', ...args], { detached: true, stdio: 'ignore' })
    child.on('exit', (code) => settle(code === 0 ? null : `open exited with ${code}`))
    child.on('error', (err) => settle(`open could not run (${err.message})`))
    const timer = setTimeout(() => settle(null), opts.openTimeoutMs ?? 10_000)
  })
}

/**
 * Remove what an update left beside the app: the previous copy, or a half-unpacked new one.
 * Called at every launch; swallows "still in use", which the next launch will see again.
 *
 * A previous copy that is the ONLY copy is put back instead: originals a failed rollback left
 * in `.update-old` (`restoreSetAside`), or a bundle left only at `.app.old`. Until that works,
 * it is kept.
 */
export function cleanUpAfterUpdate(target: InstallTarget | null): void {
  if (!target) return
  let leftovers: string[]
  if (target.layout === 'bundle') {
    const old = `${target.path}.old`
    if (!fs.existsSync(target.path) && fs.existsSync(old)) {
      try {
        fs.renameSync(old, target.path)
      } catch {
        // Kept for the next launch, or the next install, to put back.
      }
    }
    leftovers = [`${target.path}.new`, ...(fs.existsSync(target.path) ? [old] : [])]
  } else {
    leftovers = [path.join(target.path, NEW_DIR), ...(restoreSetAside(target.path) ? [path.join(target.path, OLD_DIR)] : [])]
  }
  for (const p of leftovers) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      // Still in use; the next launch tries again.
    }
  }
}
