/**
 * The macOS swap on a real, tiny, ad-hoc signed bundle. Only runs on macOS: it needs ditto and
 * codesign, and the bundle layout means nothing elsewhere.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyBundleUpdate } from './swap-bundle'

const darwin = process.platform === 'darwin'
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

describe.skipIf(!darwin)('applyBundleUpdate', () => {
  test('the new bundle takes the old one\'s place, sealed, symlinks intact, nothing left beside it', async () => {
    const oldApp = await makeApp(fs.mkdtempSync(path.join(tmp, 'installed-')), 'old')
    const newApp = await makeApp(fs.mkdtempSync(path.join(tmp, 'build-')), 'new')
    const zip = path.join(tmp, 'Tiny-new.zip')
    await run(['ditto', '-c', '-k', '--norsrc', '--noextattr', '--keepParent', newApp, zip])

    const events: string[] = []
    await applyBundleUpdate(zip, { layout: 'bundle', path: oldApp, executable: path.join(oldApp, 'Contents/MacOS/tiny') }, { appName: 'Tiny', bundleExecutable: 'tiny', onSwapping: () => events.push('swapping') })
    expect(events).toEqual(['swapping'])
    expect(fs.readFileSync(path.join(oldApp, 'Contents/MacOS/tiny'), 'utf8')).toContain('echo new')
    expect(fs.lstatSync(path.join(oldApp, 'Contents/MacOS/vendor')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(oldApp, 'Contents/MacOS/vendor/tool'), 'utf8')).toBe('new')
    expect(fs.readdirSync(path.dirname(oldApp))).toEqual(['Tiny.app'])
    await run(['codesign', '--verify', '--deep', '--strict', oldApp])
  })

  test('a zip without the app in it, and a tampered bundle, change nothing', async () => {
    const oldApp = await makeApp(fs.mkdtempSync(path.join(tmp, 'installed2-')), 'old')
    const target = { layout: 'bundle' as const, path: oldApp, executable: path.join(oldApp, 'Contents/MacOS/tiny') }
    const other = fs.mkdtempSync(path.join(tmp, 'other-'))
    fs.writeFileSync(path.join(other, 'readme.txt'), 'x')
    const noApp = path.join(tmp, 'noapp.zip')
    await run(['ditto', '-c', '-k', other, noApp])
    await expect(applyBundleUpdate(noApp, target, { appName: 'Tiny', bundleExecutable: 'tiny' })).rejects.toThrow(/no Tiny app/)

    const tampered = await makeApp(fs.mkdtempSync(path.join(tmp, 'tampered-')), 'new')
    fs.writeFileSync(path.join(tampered, 'Contents/Resources/vendor/tool'), 'edited after signing')
    const badZip = path.join(tmp, 'tampered.zip')
    await run(['ditto', '-c', '-k', '--keepParent', tampered, badZip])
    const err = await applyBundleUpdate(badZip, target, { appName: 'Tiny', bundleExecutable: 'tiny' }).catch((e) => e)
    expect(err.code).toBe('damaged')
    // The message is shown to the user: no paths, no codesign output. That is kept for the log.
    expect(err.message).toBe("The update's signature doesn't check out.")
    expect(err.cause.message).toMatch(/^codesign exited \d+: .*Tiny\.app/)
    expect(fs.readFileSync(path.join(oldApp, 'Contents/MacOS/tiny'), 'utf8')).toContain('echo old')
    expect(fs.readdirSync(path.dirname(oldApp))).toEqual(['Tiny.app'])
  })

  const newZip = async (name: string) => {
    const zip = path.join(tmp, `${name}.zip`)
    await run(['ditto', '-c', '-k', '--norsrc', '--noextattr', '--keepParent', await makeApp(fs.mkdtempSync(path.join(tmp, `${name}-`)), 'new'), zip])
    return zip
  }
  const targetOf = (app: string) => ({ layout: 'bundle' as const, path: app, executable: path.join(app, 'Contents/MacOS/tiny') })

  test('a swap that cannot put the app back leaves it at .old, and the next swap puts it back before anything else', async () => {
    const oldApp = await makeApp(fs.mkdtempSync(path.join(tmp, 'installed3-')), 'old')
    const zip = await newZip('build3')
    // The new bundle will not move in, and the old one will not move back.
    const rename = (from: string, to: string) => {
      if (to === oldApp) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      fs.renameSync(from, to)
    }
    const err = await applyBundleUpdate(zip, targetOf(oldApp), { appName: 'Tiny', bundleExecutable: 'tiny', rename }).catch((e) => e)
    expect(err.code).toBe('swap_failed')
    expect(err.message).toBe("Tiny couldn't swap the update in or put itself back. In the folder Tiny was in, rename Tiny.app.old to Tiny.app.")
    expect(fs.readdirSync(path.dirname(oldApp))).toEqual(['Tiny.app.old'])

    await applyBundleUpdate(zip, targetOf(oldApp), { appName: 'Tiny', bundleExecutable: 'tiny' })
    expect(fs.readFileSync(path.join(oldApp, 'Contents/MacOS/tiny'), 'utf8')).toContain('echo new')
    expect(fs.readdirSync(path.dirname(oldApp))).toEqual(['Tiny.app'])
  })

  test.skipIf(process.getuid?.() === 0)('an old bundle that will not be removed does not fail a swap that worked', async () => {
    const oldApp = await makeApp(fs.mkdtempSync(path.join(tmp, 'installed4-')), 'old')
    // A vendored toolchain's read-only folder: rm can't empty it.
    const locked = path.join(oldApp, 'Contents', 'Resources', 'locked')
    fs.mkdirSync(locked)
    fs.writeFileSync(path.join(locked, 'tool'), 'x')
    fs.chmodSync(locked, 0o555)
    try {
      await applyBundleUpdate(await newZip('build4'), targetOf(oldApp), { appName: 'Tiny', bundleExecutable: 'tiny', verifySignature: false })
      expect(fs.readFileSync(path.join(oldApp, 'Contents/MacOS/tiny'), 'utf8')).toContain('echo new')
      expect(fs.existsSync(`${oldApp}.old`)).toBe(true) // left for the next launch's cleanup
    } finally {
      fs.chmodSync(path.join(`${oldApp}.old`, 'Contents', 'Resources', 'locked'), 0o755)
    }
  })
})
