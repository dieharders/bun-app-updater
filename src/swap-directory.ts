/**
 * The directory layout's swap: Windows and Linux, where the app is an executable in a
 * directory with whatever the build staged beside it.
 *
 * THE SWAP IS A RENAME, never an overwrite. A running program cannot be overwritten, but on
 * every platform it can be renamed — and a rename keeps the old copy whole until the moment
 * the new one is in place, so a failure anywhere leaves something to put back.
 *
 *   1. The archives — one per top-level entry the update replaces (see manifest.ts) — are
 *      unpacked into `<dir>/.update-new/`. Same volume as the install, so the moves below are
 *      renames (instant, atomic) rather than copies across volumes.
 *   2. For each entry at the TOP of the unpacked tree — the executable, `vendor/`, whatever
 *      the parts carry — the installed one is moved to `<dir>/.update-old/<name>` and the new
 *      one moved into place. Entries the parts do not carry are never touched: the ones whose
 *      content already matches the release, an installer's uninstaller, a browser runtime's
 *      profile folder beside the exe, a desktop file.
 *   3. If any move fails, the ones already made are undone in reverse order, and the install
 *      is as it was.
 *   4. `.update-new` is removed. `.update-old` is removed too, except on Windows, where the
 *      old executable is still running and cannot be deleted until the next launch
 *      (`cleanUpAfterUpdate` in relaunch.ts).
 *
 * Windows can refuse a rename for a moment for reasons that have nothing to do with the app:
 * an antivirus scanning the new files, the search indexer, an Explorer window open in the
 * folder. Each move is retried a few times before it counts as a failure.
 */
import fs from 'node:fs'
import path from 'node:path'
import { UpdateError } from './errors'
import type { InstallTarget } from './target'
import { applyZipModes, unzipToDir } from './zip'

export const NEW_DIR = '.update-new'
export const OLD_DIR = '.update-old'

export interface DirectorySwapOptions {
  platform?: NodeJS.Platform
  signal?: AbortSignal
  onUnpackProgress?: (done: number, total: number) => void
  onSwapping?: () => void
  /** For messages. */
  appName: string
  /**
   * The top-level entries the archives must add up to, exactly. A part zipped from the wrong
   * directory would otherwise put a stranger beside the executable, or miss the entry it was
   * meant to replace, and nothing would say so until the next launch.
   */
  expect?: string[]
  /** Injectable for the rollback test; defaults to fs.renameSync. */
  rename?: (from: string, to: string) => void
  /** Retry pacing, in ms, for a move Windows refuses transiently. */
  retryDelaysMs?: number[]
}

const DEFAULT_RETRIES = [200, 400, 600, 800, 1000]

export async function applyDirectoryUpdate(zipPaths: string[], target: InstallTarget, opts: DirectorySwapOptions): Promise<void> {
  const platform = opts.platform ?? process.platform
  const dir = target.path
  const fresh = path.join(dir, NEW_DIR)
  const old = path.join(dir, OLD_DIR)
  const rename = opts.rename ?? fs.renameSync
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRIES

  fs.rmSync(fresh, { recursive: true, force: true })
  // Progress is over the archives' bytes together, so the bar does not restart per part.
  const sizes = zipPaths.map((z) => fs.statSync(z).size)
  const totalBytes = sizes.reduce((a, b) => a + b, 0)
  let doneBefore = 0
  const topLevel = new Set<string>()
  for (const [i, zipPath] of zipPaths.entries()) {
    const result = await unzipToDir(zipPath, fresh, { signal: opts.signal, onProgress: (done) => opts.onUnpackProgress?.(doneBefore + done, totalBytes) })
    applyZipModes(zipPath, fresh, platform)
    for (const name of result.topLevel) topLevel.add(name)
    doneBefore += sizes[i]!
  }

  if (opts.expect) {
    const want = [...opts.expect].sort()
    const have = [...topLevel].sort()
    if (want.length !== have.length || want.some((n, i) => n !== have[i])) {
      fs.rmSync(fresh, { recursive: true, force: true })
      throw new UpdateError('damaged', `The update's download doesn't hold what the release says it does (expected ${want.join(', ')}; got ${have.join(', ') || 'nothing'}).`)
    }
  }
  const entries = [...topLevel]

  opts.onSwapping?.()
  if (opts.signal?.aborted) {
    fs.rmSync(fresh, { recursive: true, force: true })
    throw new UpdateError('cancelled', 'The update was cancelled.')
  }

  // A previous run's leftovers: a failed cleanup on Windows holds only the old exe, which a
  // later launch removes; here it must go so this run's set-aside names are free.
  fs.rmSync(old, { recursive: true, force: true })
  fs.mkdirSync(old, { recursive: true })

  const moveWithRetry = async (from: string, to: string): Promise<void> => {
    let attempt = 0
    for (;;) {
      try {
        rename(from, to)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
        if (!transient || attempt >= delays.length) throw err
        await Bun.sleep(delays[attempt++]!)
      }
    }
  }

  // What has been moved so far, for the rollback: [installed path, set-aside path, new path].
  const applied: { place: string; aside: string | null; incoming: string }[] = []
  try {
    for (const name of entries) {
      const place = path.join(dir, name)
      const incoming = path.join(fresh, name)
      const aside = path.join(old, name)
      const existed = fs.existsSync(place)
      if (existed) await moveWithRetry(place, aside)
      applied.push({ place, aside: existed ? aside : null, incoming })
      try {
        await moveWithRetry(incoming, place)
      } catch (err) {
        // The set-aside succeeded and the move-in failed: put the set-aside back before the
        // general rollback, which only knows about completed pairs.
        applied.pop()
        if (existed) {
          try {
            rename(aside, place)
          } catch {
            // Left for the rollback below to report; the user's copy is in .update-old.
          }
        }
        throw err
      }
    }
  } catch (err) {
    for (const step of applied.reverse()) {
      try {
        rename(step.place, step.incoming)
        if (step.aside) rename(step.aside, step.place)
      } catch {
        // Rollback is best effort; what it could not restore is still in .update-old.
      }
    }
    fs.rmSync(fresh, { recursive: true, force: true })
    try {
      fs.rmSync(old, { recursive: true, force: true })
    } catch {
      // Still held; the next launch tries again.
    }
    const code = (err as NodeJS.ErrnoException).code
    const entry = (err as NodeJS.ErrnoException).path ? ` (${path.basename((err as NodeJS.ErrnoException).path!)})` : ''
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      throw new UpdateError(
        'swap_failed',
        `${opts.appName} can't replace itself where it's installed${entry}. Close any window open in its folder and try again, or download the update instead.`,
        { cause: err },
      )
    }
    throw new UpdateError('swap_failed', `${opts.appName} couldn't swap the update in${entry}.`, { cause: err })
  }

  fs.rmSync(fresh, { recursive: true, force: true })
  // The old executable is still running. On POSIX its file can be unlinked anyway; Windows
  // keeps it locked, so the next launch removes it.
  if (platform !== 'win32') {
    try {
      fs.rmSync(old, { recursive: true, force: true })
    } catch {
      // Left for cleanUpAfterUpdate.
    }
  }
}
