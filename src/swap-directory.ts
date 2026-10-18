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
 * folder. Each move is retried a few times before it counts as a failure, the rollback's too.
 *
 * AN ORIGINAL THE ROLLBACK COULD NOT PUT BACK IS NEVER REMOVED. `.update-old` is then the only
 * copy of it, so the folder stays, with a restore list naming what is still in it, and
 * `restoreSetAside` puts those back at the next launch or before the next install, whichever
 * comes first. Until then nothing removes `.update-old`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { UpdateError } from './errors'
import type { InstallTarget } from './target'
import { applyZipModes, unzipToDir } from './zip'

export const NEW_DIR = '.update-new'
export const OLD_DIR = '.update-old'
/** In `.update-old`: the entries a failed rollback could not put back, as a JSON array of names. */
const RESTORE_LIST = '.restore.json'
/** In `.update-old`: where `restoreSetAside` moves the update's copy of an entry out of the way. */
const DISPLACED = '.displaced'

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

  // Before anything below removes .update-old: an earlier failed rollback's originals go back first.
  if (!restoreSetAside(dir)) {
    throw new UpdateError('swap_failed', `${opts.appName} couldn't put back the files an earlier update set aside. Restart ${opts.appName} and try again.`)
  }

  fs.rmSync(fresh, { recursive: true, force: true })
  // Progress is over the archives' bytes together, so the bar does not restart per part.
  const sizes = zipPaths.map((z) => fs.statSync(z).size)
  const totalBytes = sizes.reduce((a, b) => a + b, 0)
  let doneBefore = 0
  const topLevel = new Set<string>()
  try {
    for (const [i, zipPath] of zipPaths.entries()) {
      const result = await unzipToDir(zipPath, fresh, { signal: opts.signal, onProgress: (done) => opts.onUnpackProgress?.(doneBefore + done, totalBytes) })
      applyZipModes(zipPath, fresh, platform)
      for (const name of result.topLevel) topLevel.add(name)
      doneBefore += sizes[i]!
    }
  } catch (err) {
    removeQuietly(fresh)
    throw err
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

  // What has been moved so far, for the rollback: the installed path, where the original was set
  // aside (null when there was none), where the new one came from, and whether it is in place yet.
  const applied: { name: string; place: string; aside: string | null; incoming: string; movedIn: boolean }[] = []
  try {
    for (const name of entries) {
      const place = path.join(dir, name)
      const step = { name, place, aside: null as string | null, incoming: path.join(fresh, name), movedIn: false }
      if (fs.existsSync(place)) {
        await moveWithRetry(place, path.join(old, name))
        step.aside = path.join(old, name)
      }
      applied.push(step)
      await moveWithRetry(step.incoming, place)
      step.movedIn = true
    }
  } catch (err) {
    // Undone in reverse. An original that cannot be put back is left in .update-old and named
    // in the restore list; the folder is its only copy now, so it is kept.
    const stranded: string[] = []
    for (const step of applied.reverse()) {
      try {
        if (step.movedIn) await moveWithRetry(step.place, step.incoming)
        if (step.aside) await moveWithRetry(step.aside, step.place)
      } catch {
        if (step.aside) stranded.push(step.name)
      }
    }
    removeQuietly(fresh)
    if (stranded.length > 0) {
      try {
        fs.writeFileSync(path.join(old, RESTORE_LIST), JSON.stringify(stranded))
      } catch {
        // Nothing more to do from here; the folder itself is kept.
      }
      throw new UpdateError(
        'swap_failed',
        `${opts.appName} couldn't swap the update in or put all of its own files back. Restart ${opts.appName} to finish putting them back, or reinstall it if it won't start.`,
        { cause: err },
      )
    }
    removeQuietly(old)
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

  // The update is in place: what is left is cleanup, and cleanUpAfterUpdate retries it.
  removeQuietly(fresh)
  // The old executable is still running. On POSIX its file can be unlinked anyway; Windows
  // keeps it locked, so the next launch removes it.
  if (platform !== 'win32') removeQuietly(old)
}

/**
 * Put back the originals a failed rollback left in `.update-old`, as its restore list names
 * them. Where the update's copy of an entry is still in place, it is moved out of the way first.
 *
 * True when nothing is left to put back, so `.update-old` may be removed. False while something
 * is: the folder is the only copy of it then, and must be kept.
 */
export function restoreSetAside(dir: string): boolean {
  const old = path.join(dir, OLD_DIR)
  const list = path.join(old, RESTORE_LIST)
  if (!exists(list)) return true
  let names: unknown
  try {
    names = JSON.parse(fs.readFileSync(list, 'utf8'))
  } catch {
    return false
  }
  if (!Array.isArray(names)) return false
  const left = names.filter((name: unknown) => {
    // Written by the rollback above, so always a top-level entry's name; anything else is skipped.
    if (typeof name !== 'string' || !name || /[\\/]/.test(name) || name === '.' || name === '..') return false
    const aside = path.join(old, name)
    const place = path.join(dir, name)
    if (!exists(aside)) return false
    try {
      if (exists(place)) {
        const displaced = path.join(old, DISPLACED, name)
        fs.mkdirSync(path.dirname(displaced), { recursive: true })
        fs.rmSync(displaced, { recursive: true, force: true })
        fs.renameSync(place, displaced)
      }
      fs.renameSync(aside, place)
      return false
    } catch {
      return true
    }
  })
  try {
    if (left.length > 0) fs.writeFileSync(list, JSON.stringify(left))
    else fs.rmSync(list, { force: true })
  } catch {
    return false
  }
  return left.length === 0
}

const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

const removeQuietly = (p: string): void => {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    // Still held; cleanUpAfterUpdate tries again at the next launch.
  }
}
