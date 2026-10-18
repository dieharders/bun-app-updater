/** The directory swap on a scratch install: entries replaced, strangers kept, rollback on failure. */
import { afterAll, describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanUpAfterUpdate } from './relaunch'
import { NEW_DIR, OLD_DIR, applyDirectoryUpdate } from './swap-directory'
import type { InstallTarget } from './target'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-swap-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const enc = (s: string) => new TextEncoder().encode(s)

/** A fake install: the exe, a vendor tree, and an uninstaller the update must not touch. */
const install = (exeName: string): InstallTarget => {
  const dir = fs.mkdtempSync(path.join(tmp, 'app-'))
  fs.writeFileSync(path.join(dir, exeName), 'old exe')
  fs.mkdirSync(path.join(dir, 'vendor'))
  fs.writeFileSync(path.join(dir, 'vendor', 'ffmpeg'), 'old ffmpeg')
  fs.writeFileSync(path.join(dir, 'vendor', 'only-old.txt'), 'gone after update')
  fs.writeFileSync(path.join(dir, 'unins000.exe'), 'uninstaller')
  return { layout: 'directory', path: dir, executable: path.join(dir, exeName) }
}
/** The release's parts: one zip per top-level entry, as the build publishes them. */
const build = (exeName: string): string[] => {
  const write = (name: string, files: Parameters<typeof zipSync>[0]) => {
    const p = path.join(tmp, `build-${Math.random().toString(36).slice(2)}-${name}.zip`)
    fs.writeFileSync(p, zipSync(files))
    return p
  }
  return [
    write('exe', { [exeName]: enc('new exe') }),
    write('vendor', { 'vendor/ffmpeg': [enc('new ffmpeg'), { os: 3, attrs: 0o100755 << 16 }] }),
    write('library', { 'library/fonts.css': enc('css') }),
  ]
}
const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out[r] = fs.readFileSync(path.join(d, e.name), 'utf8')
    }
  }
  walk(dir, '')
  return out
}

describe('applyDirectoryUpdate', () => {
  test('Linux: the parts replace their entries, keep the rest, and leave nothing aside', async () => {
    const t = install('app')
    const events: string[] = []
    const progress: [number, number][] = []
    await applyDirectoryUpdate(build('app'), t, { appName: 'App', platform: 'linux', onSwapping: () => events.push('swapping'), onUnpackProgress: (d, total) => progress.push([d, total]) })
    expect(tree(t.path)).toEqual({ app: 'new exe', 'vendor/ffmpeg': 'new ffmpeg', 'library/fonts.css': 'css', 'unins000.exe': 'uninstaller' })
    if (process.platform !== 'win32') expect(fs.statSync(path.join(t.path, 'vendor', 'ffmpeg')).mode & 0o111).toBeTruthy()
    expect(events.at(-1)).toBe('swapping')
    // One bar over all the parts: the total never changes and the count never goes back.
    expect(new Set(progress.map(([, total]) => total)).size).toBe(1)
    expect(progress.every(([d], i) => i === 0 || d >= progress[i - 1]![0])).toBe(true)
    expect(progress.at(-1)![0]).toBe(progress.at(-1)![1])
  })

  test('only the stale parts: an entry no part carries is left exactly as it was', async () => {
    const t = install('app')
    const [exe] = build('app')
    await applyDirectoryUpdate([exe!], t, { appName: 'App', platform: 'linux', expect: ['app'] })
    expect(tree(t.path)).toEqual({ app: 'new exe', 'vendor/ffmpeg': 'old ffmpeg', 'vendor/only-old.txt': 'gone after update', 'unins000.exe': 'uninstaller' })
  })

  test('Windows: the old copy waits in .update-old until the next launch removes it', async () => {
    const t = install('app.exe')
    await applyDirectoryUpdate(build('app.exe'), t, { appName: 'App', platform: 'win32' })
    expect(fs.readFileSync(t.executable, 'utf8')).toBe('new exe')
    expect(fs.readFileSync(path.join(t.path, OLD_DIR, 'app.exe'), 'utf8')).toBe('old exe')
    expect(fs.readFileSync(path.join(t.path, OLD_DIR, 'vendor', 'only-old.txt'), 'utf8')).toBe('gone after update')
    expect(fs.existsSync(path.join(t.path, NEW_DIR))).toBe(false)
    cleanUpAfterUpdate(t)
    expect(fs.readdirSync(t.path).sort()).toEqual(['app.exe', 'library', 'unins000.exe', 'vendor'])
  })

  test('parts that do not add up to what the release promised change nothing', async () => {
    const t = install('app')
    const before = tree(t.path)
    // The manifest said app + vendor; the zips hold other + vendor + library.
    await expect(applyDirectoryUpdate(build('other'), t, { appName: 'App', platform: 'linux', expect: ['app', 'vendor'] })).rejects.toThrow(/expected app, vendor; got library, other, vendor/)
    expect(tree(t.path)).toEqual(before)
    expect(fs.existsSync(path.join(t.path, NEW_DIR))).toBe(false)
  })

  test('a move that keeps failing rolls every earlier move back', async () => {
    const t = install('app')
    const before = tree(t.path)
    let calls = 0
    const rename = (from: string, to: string) => {
      // Refuse to move the new library in, every time, the way a locked folder would.
      if (path.basename(to) === 'library' && from.includes(NEW_DIR)) {
        calls++
        const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
        err.code = 'EPERM'
        err.path = from
        throw err
      }
      fs.renameSync(from, to)
    }
    const err = await applyDirectoryUpdate(build('app'), t, { appName: 'App', platform: 'win32', rename, retryDelaysMs: [1, 1] }).catch((e) => e)
    expect(err.code).toBe('swap_failed')
    expect(err.message).toMatch(/library/)
    expect(calls).toBe(3)
    expect(tree(t.path)).toEqual(before)
    expect(fs.existsSync(path.join(t.path, NEW_DIR))).toBe(false)
  })

  /** Refuses, every time, the moves `refuse` picks out: a lock that outlasts the retries. */
  const refusing = (refuse: (from: string, to: string) => boolean) => (from: string, to: string) => {
    if (refuse(from, to)) {
      const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
      err.code = 'EPERM'
      err.path = from
      throw err
    }
    fs.renameSync(from, to)
  }
  const inside = (p: string, dir: string) => p.split(path.sep).includes(dir)

  test('an original the rollback cannot put back is kept, and the next launch puts it back', async () => {
    const t = install('app')
    const before = tree(t.path)
    // The new library will not move in, and the old vendor will not move back out of .update-old.
    const rename = refusing((from, to) => (path.basename(to) === 'library' && inside(from, NEW_DIR)) || (path.basename(from) === 'vendor' && inside(from, OLD_DIR)))
    const err = await applyDirectoryUpdate(build('app'), t, { appName: 'App', platform: 'linux', rename, retryDelaysMs: [1] }).catch((e) => e)
    expect(err.code).toBe('swap_failed')
    expect(err.message).toMatch(/put all of its own files back/)
    // The user's vendor is not gone: it waits in .update-old, which is not removed.
    expect(fs.readFileSync(path.join(t.path, OLD_DIR, 'vendor', 'only-old.txt'), 'utf8')).toBe('gone after update')
    expect(fs.readFileSync(t.executable, 'utf8')).toBe('old exe')
    cleanUpAfterUpdate(t)
    expect(tree(t.path)).toEqual(before)
    expect(fs.existsSync(path.join(t.path, OLD_DIR))).toBe(false)
  })

  test('where the update\'s copy could not be moved back out, the next install puts the original back before anything else', async () => {
    const t = install('app')
    // The new library will not move in, and the new vendor will not move back out of place.
    const rename = refusing((from, to) => (path.basename(to) === 'library' && inside(from, NEW_DIR)) || (path.basename(from) === 'vendor' && inside(to, NEW_DIR)))
    const err = await applyDirectoryUpdate(build('app'), t, { appName: 'App', platform: 'linux', rename, retryDelaysMs: [1] }).catch((e) => e)
    expect(err.code).toBe('swap_failed')
    expect(fs.readFileSync(path.join(t.path, 'vendor', 'ffmpeg'), 'utf8')).toBe('new ffmpeg') // stuck in place
    expect(fs.readFileSync(path.join(t.path, OLD_DIR, 'vendor', 'ffmpeg'), 'utf8')).toBe('old ffmpeg')
    // The next install starts by removing .update-old; the original vendor goes back first, then the swap runs.
    const [exe] = build('app')
    await applyDirectoryUpdate([exe!], t, { appName: 'App', platform: 'linux', expect: ['app'] })
    expect(tree(t.path)).toEqual({ app: 'new exe', 'vendor/ffmpeg': 'old ffmpeg', 'vendor/only-old.txt': 'gone after update', 'unins000.exe': 'uninstaller' })
    expect(fs.existsSync(path.join(t.path, OLD_DIR))).toBe(false)
  })

  test('cancelled while unpacking: nothing is moved, nothing is left', async () => {
    const t = install('app')
    const before = tree(t.path)
    const ac = new AbortController()
    ac.abort()
    const err = await applyDirectoryUpdate(build('app'), t, { appName: 'App', platform: 'linux', signal: ac.signal }).catch((e) => e)
    expect(err.code).toBe('cancelled')
    expect(tree(t.path)).toEqual(before)
    expect(fs.existsSync(path.join(t.path, NEW_DIR))).toBe(false)
  })
})
