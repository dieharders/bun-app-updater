/**
 * The macOS swap on a real, tiny, ad-hoc signed bundle on a real disk image. Only runs on macOS:
 * it needs hdiutil, ditto and codesign, and the bundle layout means nothing elsewhere.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { STAGING_PID, applyBundleUpdate, exchangePaths } from './swap-bundle'

const darwin = process.platform === 'darwin'
/** hdiutil create and attach take seconds each, past bun's 5s default. */
const SLOW = 60_000
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-bundle-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`${cmd.join(' ')}: ${err}`)
}

/** A bundle with a shell script for an executable, a Resources dir and a symlink to it, sealed. */
const makeApp = async (dir: string, marker: string): Promise<string> => {
  const app = path.join(dir, 'Tiny.app')
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  fs.mkdirSync(path.join(app, 'Contents', 'Resources', 'vendor'), { recursive: true })
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'tiny'), `#!/bin/sh\necho ${marker}\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'vendor', 'tool'), marker)
  fs.symlinkSync('../Resources/vendor', path.join(app, 'Contents', 'MacOS', 'vendor'))
  fs.writeFileSync(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>tiny</string><key>CFBundleIdentifier</key><string>test.tiny</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  )
  await run(['codesign', '--force', '-s', '-', app])
  return app
}

/** A DMG laid out the way a release's is: the app and a link to /Applications. */
const makeDmg = async (name: string, fill: (dir: string) => Promise<void>): Promise<string> => {
  const src = fs.mkdtempSync(path.join(tmp, `${name}-src-`))
  await fill(src)
  fs.symlinkSync('/Applications', path.join(src, 'Applications'))
  const dmg = path.join(tmp, `${name}.dmg`)
  await run(['hdiutil', 'create', '-volname', 'Tiny', '-srcfolder', src, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg])
  return dmg
}
const newDmg = (name: string) => makeDmg(name, (dir) => makeApp(dir, 'new').then(() => {}))

const installed = async (name: string) => {
  const app = await makeApp(fs.mkdtempSync(path.join(tmp, `${name}-`)), 'old')
  return { app, target: { layout: 'bundle' as const, path: app, executable: path.join(app, 'Contents/MacOS/tiny') } }
}
const opts = { appName: 'Tiny', bundleExecutable: 'tiny' }
const mounts = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tiny-update-mount-'))

describe.skipIf(!darwin)('applyBundleUpdate', () => {
  test('the new bundle takes the old one\'s place, sealed, symlinks intact, nothing left beside it or mounted', async () => {
    const { app, target } = await installed('installed')
    const before = mounts()
    const events: string[] = []
    await applyBundleUpdate(await newDmg('build'), target, { ...opts, onSwapping: () => events.push('swapping') })
    expect(events).toEqual(['swapping'])
    expect(fs.readFileSync(path.join(app, 'Contents/MacOS/tiny'), 'utf8')).toContain('echo new')
    expect(fs.lstatSync(path.join(app, 'Contents/MacOS/vendor')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(app, 'Contents/MacOS/vendor/tool'), 'utf8')).toBe('new')
    expect(fs.readdirSync(path.dirname(app))).toEqual(['Tiny.app'])
    expect(mounts()).toEqual(before)
    await run(['codesign', '--verify', '--deep', '--strict', app])
  }, SLOW)

  test('a disk image without the app on it, and a tampered bundle, change nothing', async () => {
    const { app, target } = await installed('installed2')
    const noApp = await makeDmg('noapp', async (dir) => fs.writeFileSync(path.join(dir, 'readme.txt'), 'x'))
    await expect(applyBundleUpdate(noApp, target, opts)).rejects.toThrow(/no Tiny app/)
    expect(fs.readdirSync(path.dirname(app))).toEqual(['Tiny.app'])

    const tampered = await makeDmg('tampered', async (dir) => {
      const built = await makeApp(dir, 'new')
      fs.writeFileSync(path.join(built, 'Contents/Resources/vendor/tool'), 'edited after signing')
    })
    const err = await applyBundleUpdate(tampered, target, opts).catch((e) => e)
    expect(err.code).toBe('damaged')
    // The message is shown to the user: no paths, no codesign output. That is kept for the log.
    expect(err.message).toBe("The update's signature doesn't check out.")
    expect(err.cause.message).toMatch(/^codesign exited \d+: .*Tiny\.app/)
    expect(fs.readFileSync(path.join(app, 'Contents/MacOS/tiny'), 'utf8')).toContain('echo old')
    expect(fs.readdirSync(path.dirname(app))).toEqual(['Tiny.app'])
  }, SLOW)

  test('a file that is not a disk image is refused as unopenable', async () => {
    const { app, target } = await installed('installed3')
    const junk = path.join(tmp, 'junk.dmg')
    fs.writeFileSync(junk, 'not a disk image')
    const err = await applyBundleUpdate(junk, target, opts).catch((e) => e)
    expect(err.code).toBe('unpack_failed')
    expect(err.message).toBe("The update's download couldn't be opened.")
    expect(fs.readdirSync(path.dirname(app))).toEqual(['Tiny.app'])
  }, SLOW)

  test('an exchange the volume refuses leaves the app as it was, and the staged copy gone', async () => {
    const { app, target } = await installed('installed4')
    let staged: string[] = []
    const exchange = (a: string) => {
      staged = fs.readdirSync(path.dirname(a))
      throw Object.assign(new Error('renamex_np(RENAME_SWAP) failed with errno 45'), { errno: 45 })
    }
    const err = await applyBundleUpdate(await newDmg('build4'), target, { ...opts, exchange }).catch((e) => e)
    expect(err.code).toBe('swap_failed')
    expect(err.message).toBe("Tiny can't replace itself where it's installed. Download the update instead.")
    expect(staged.sort()).toEqual([STAGING_PID, 'Tiny.app'].sort()) // staged beside the app, with its owner
    expect(fs.readFileSync(path.join(app, 'Contents/MacOS/tiny'), 'utf8')).toContain('echo old')
    expect(fs.readdirSync(path.dirname(app))).toEqual(['Tiny.app'])
  }, SLOW)

  test('a cancel before the swap changes nothing', async () => {
    const { app, target } = await installed('installed5')
    const ac = new AbortController()
    const err = await applyBundleUpdate(await newDmg('build5'), target, { ...opts, signal: ac.signal, onSwapping: () => ac.abort() }).catch((e) => e)
    expect(err.code).toBe('cancelled')
    expect(fs.readFileSync(path.join(app, 'Contents/MacOS/tiny'), 'utf8')).toContain('echo old')
    expect(fs.readdirSync(path.dirname(app))).toEqual(['Tiny.app'])
  }, SLOW)
})

describe.skipIf(!darwin)('exchangePaths', () => {
  test('swaps two folders in one step, and refuses a path that is not there', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'exchange-'))
    fs.mkdirSync(path.join(dir, 'a'))
    fs.writeFileSync(path.join(dir, 'a', 'which'), 'a')
    fs.mkdirSync(path.join(dir, 'b'))
    fs.writeFileSync(path.join(dir, 'b', 'which'), 'b')
    exchangePaths(path.join(dir, 'a'), path.join(dir, 'b'))
    expect(fs.readFileSync(path.join(dir, 'a', 'which'), 'utf8')).toBe('b')
    expect(fs.readFileSync(path.join(dir, 'b', 'which'), 'utf8')).toBe('a')
    expect(() => exchangePaths(path.join(dir, 'a'), path.join(dir, 'missing'))).toThrow(/errno 2\b/)
  })
})
