import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanUpAfterUpdate, waitForArg, waitForExit } from './relaunch'

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

describe('cleanUpAfterUpdate', () => {
  test('removes a bundle update\'s leftovers and tolerates their absence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-clean-'))
    const app = path.join(dir, 'App.app')
    fs.mkdirSync(`${app}.old`)
    fs.mkdirSync(`${app}.new`)
    cleanUpAfterUpdate({ layout: 'bundle', path: app, executable: path.join(app, 'Contents/MacOS/app') })
    expect(fs.readdirSync(dir)).toEqual([])
    cleanUpAfterUpdate({ layout: 'bundle', path: app, executable: '' })
    cleanUpAfterUpdate(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
