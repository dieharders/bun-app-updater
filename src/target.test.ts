import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blockedReason, installTarget, targetName } from './target'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-target-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('installTarget', () => {
  test('the directory on Windows and Linux, the .app on macOS, nothing from source', () => {
    expect(installTarget({ execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\App\\app.exe', platform: 'win32' })).toEqual({
      layout: 'directory',
      path: 'C:\\Users\\me\\AppData\\Local\\Programs\\App',
      executable: 'C:\\Users\\me\\AppData\\Local\\Programs\\App\\app.exe',
    })
    expect(installTarget({ execPath: '/opt/App/app', platform: 'linux' })).toEqual({ layout: 'directory', path: '/opt/App', executable: '/opt/App/app' })
    expect(installTarget({ execPath: '/Applications/App.app/Contents/MacOS/app', platform: 'darwin' })).toEqual({
      layout: 'bundle',
      path: '/Applications/App.app',
      executable: '/Applications/App.app/Contents/MacOS/app',
    })
    expect(installTarget({ execPath: '/Users/me/app', platform: 'darwin' })).toBeNull()
    expect(installTarget({ execPath: 'C:\\Users\\me\\.bun\\bin\\bun.exe', platform: 'win32' })).toBeNull()
    expect(installTarget({ execPath: '/usr/local/bin/bun', platform: 'linux' })).toBeNull()
  })
  test('target names', () => {
    expect(targetName('win32', 'x64')).toBe('windows-x64')
    expect(targetName('darwin', 'arm64')).toBe('darwin-arm64')
    expect(targetName('linux', 'x64')).toBe('linux-x64')
  })
})

describe('blockedReason', () => {
  test('allows a writable folder and leaves nothing behind in it', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'writable-'))
    expect(blockedReason({ layout: 'directory', path: dir, executable: path.join(dir, 'app') }, { platform: 'linux', appName: 'App' })).toBeNull()
    expect(fs.readdirSync(dir)).toEqual([])
    const app = path.join(dir, 'App.app')
    expect(blockedReason({ layout: 'bundle', path: app, executable: path.join(app, 'Contents/MacOS/app') }, { platform: 'darwin', appName: 'App' })).toBeNull()
    expect(fs.readdirSync(dir)).toEqual([])
  })
  test('refuses source, a missing or read-only folder, a translocated app, and no disk', () => {
    expect(blockedReason(null, { appName: 'App' })).toMatch(/from source/)
    expect(blockedReason({ layout: 'directory', path: path.join(tmp, 'missing'), executable: 'x' }, { platform: 'linux', appName: 'App' })).toMatch(/can't write/)
    expect(blockedReason({ layout: 'bundle', path: '/private/var/folders/x/AppTranslocation/y/d/App.app', executable: 'x' }, { platform: 'darwin', appName: 'App' })).toMatch(/Applications/)
    const dir = fs.mkdtempSync(path.join(tmp, 'space-'))
    expect(blockedReason({ layout: 'directory', path: dir, executable: 'x' }, { platform: 'linux', appName: 'App', needBytes: Number.MAX_SAFE_INTEGER })).toMatch(/disk space/)
  })
})
