import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanUpAfterUpdate, relaunch, waitForArg, waitForExit } from './relaunch'

describe('waitForArg', () => {
  test('reads the pid, ignores junk', () => {
    expect(waitForArg(['bun', 'main.ts', '--wait-for=1234'])).toBe(1234)
    expect(waitForArg(['app', '--wait-for=abc'])).toBeNull()
    expect(waitForArg(['app'])).toBeNull()
  })
})

describe('waitForExit', () => {
  test('returns once the process is gone, and at once for one that is not running', async () => {
    const child = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(400)'])
    const started = Date.now()
    await waitForExit(child.pid, 10_000)
    expect(await child.exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
    const gone = Date.now()
    await waitForExit(child.pid, 10_000)
    expect(Date.now() - gone).toBeLessThan(1_000)
  })
})

describe.skipIf(process.platform !== 'darwin')('relaunch, macOS', () => {
  test('when open fails, the executable is started directly, once, before the promise settles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-relaunch-'))
    const marker = path.join(dir, 'started')
    const exe = path.join(dir, 'tiny')
    fs.writeFileSync(exe, `#!/bin/sh\necho "$@" >> '${marker}'\n`, { mode: 0o755 })
    // No bundle at this path, so `open` exits non-zero.
    const logged: string[] = []
    await relaunch({ layout: 'bundle', path: path.join(dir, 'Missing.app'), executable: exe }, { pid: 4242, log: (l) => logged.push(l) })
    // Decided by the time the promise settles: an app that exits right after awaiting it still gets its fallback.
    expect(logged).toEqual([`open exited with 1; starting ${exe} directly`])
    for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await Bun.sleep(20)
    await Bun.sleep(100)
    expect(fs.readFileSync(marker, 'utf8')).toBe('--wait-for=4242\n')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('cleanUpAfterUpdate', () => {
  test('removes a bundle update\'s leftovers and tolerates their absence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-clean-'))
    const app = path.join(dir, 'App.app')
    fs.mkdirSync(app)
    fs.mkdirSync(`${app}.old`)
    fs.mkdirSync(`${app}.new`)
    cleanUpAfterUpdate({ layout: 'bundle', path: app, executable: path.join(app, 'Contents/MacOS/app') })
    expect(fs.readdirSync(dir)).toEqual(['App.app'])
    cleanUpAfterUpdate({ layout: 'bundle', path: app, executable: '' })
    cleanUpAfterUpdate(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  test('a bundle left only at .old is put back, never removed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-clean-'))
    const app = path.join(dir, 'App.app')
    fs.mkdirSync(`${app}.old`)
    fs.writeFileSync(path.join(`${app}.old`, 'marker'), 'the only copy')
    cleanUpAfterUpdate({ layout: 'bundle', path: app, executable: path.join(app, 'Contents/MacOS/app') })
    expect(fs.readdirSync(dir)).toEqual(['App.app'])
    expect(fs.readFileSync(path.join(app, 'marker'), 'utf8')).toBe('the only copy')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
