import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanUpAfterUpdate, finishUpdate, isAlive, pendingInstaller, relaunch, resumeStagedInstall, stageDir, waitForArg, waitForExit, writePendingInstaller } from './relaunch'
import { STAGING_PID } from './swap-bundle'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-relaunch-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const posix = process.platform !== 'win32'

/** A stand-in executable that appends its arguments to `<dir>/started`, and the file to read them back from. */
const recorder = (dir: string, name: string) => {
  const marker = path.join(dir, `${name}.started`)
  const exe = path.join(dir, name)
  fs.writeFileSync(exe, `#!/bin/sh\necho "$@" >> '${marker}'\n`, { mode: 0o755 })
  const read = async () => {
    for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await Bun.sleep(20)
    await Bun.sleep(50)
    return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null
  }
  return { exe, read }
}

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
    expect(isAlive(child.pid)).toBe(true)
    const started = Date.now()
    await waitForExit(child.pid, 10_000)
    expect(await child.exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(isAlive(child.pid)).toBe(false)
    const gone = Date.now()
    await waitForExit(child.pid, 10_000)
    expect(Date.now() - gone).toBeLessThan(1_000)
  })
})

describe.skipIf(process.platform !== 'darwin')('relaunch, macOS', () => {
  test('when open fails, the executable is started directly, once, before the promise settles', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'open-'))
    const { exe, read } = recorder(dir, 'tiny')
    // No bundle at this path, so `open` exits non-zero.
    const logged: string[] = []
    await relaunch({ layout: 'bundle', path: path.join(dir, 'Missing.app'), executable: exe }, { pid: 4242, log: (l) => logged.push(l) })
    // Decided by the time the promise settles: an app that exits right after awaiting it still gets its fallback.
    expect(logged).toEqual([`open exited with 1; starting ${exe} directly`])
    expect(await read()).toBe('--wait-for=4242\n')
  })
  test('with an environment, the executable is started directly with it, in this working directory — not through open', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'open-env-'))
    const marker = path.join(dir, 'started')
    const exe = path.join(dir, 'tiny')
    fs.writeFileSync(exe, `#!/bin/sh\necho "$MARK $(pwd) $@" >> '${marker}'\n`, { mode: 0o755 })
    const logged: string[] = []
    await relaunch({ layout: 'bundle', path: path.join(dir, 'Missing.app'), executable: exe }, { pid: 4242, env: { ...process.env, MARK: 'from-the-terminal' }, log: (l) => logged.push(l) })
    for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await Bun.sleep(20)
    expect(logged).toEqual([]) // `open` was never tried
    expect(fs.readFileSync(marker, 'utf8')).toBe(`from-the-terminal ${fs.realpathSync(process.cwd())} --wait-for=4242\n`)
  })
})

describe.skipIf(!posix)('finishUpdate', () => {
  const handoff = { args: ({ installDir, pid, relaunch }: { installDir: string; pid: number; relaunch: boolean }) => ['/SILENT', `/DIR=${installDir}`, `/WAITPID=${pid}`, ...(relaunch ? ['/RELAUNCH=1'] : [])] }

  test('a staged installer runs as the app quits, told to relaunch only when the user asked; the app itself is not started', async () => {
    for (const ask of [true, false]) {
      const dir = fs.mkdtempSync(path.join(tmp, 'finish-'))
      const downloadDir = path.join(dir, 'downloads')
      const app = recorder(dir, 'app')
      const stage = stageDir('App', { downloadDir })
      fs.mkdirSync(stage, { recursive: true })
      const setup = recorder(stage, 'setup')
      writePendingInstaller(stage, { version: '1.1.0', file: setup.exe })
      expect(pendingInstaller('App', { downloadDir })).toEqual({ version: '1.1.0', file: setup.exe })
      await finishUpdate({ target: { layout: 'directory', path: dir, executable: app.exe }, appName: 'App', relaunch: ask, installer: handoff, downloadDir, platform: 'linux' })
      expect(await setup.read()).toBe(`/SILENT /DIR=${dir} /WAITPID=${process.pid}${ask ? ' /RELAUNCH=1' : ''}\n`)
      expect(await app.read()).toBeNull()
      // Used up: an install that fails and starts the old version again does not run it again.
      expect(pendingInstaller('App', { downloadDir })).toBeNull()
      expect(await resumeStagedInstall({ target: { layout: 'directory', path: dir, executable: app.exe }, appName: 'App', version: '1.0.0', installer: handoff, downloadDir })).toBe(false)
    }
  })
  test('an installer that cannot start falls back to starting the app as it is, on a restart', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'finish-bad-'))
    const downloadDir = path.join(dir, 'downloads')
    const app = recorder(dir, 'app')
    const stage = stageDir('App', { downloadDir })
    fs.mkdirSync(stage, { recursive: true })
    const setup = path.join(stage, 'setup')
    fs.writeFileSync(setup, 'not executable', { mode: 0o644 })
    writePendingInstaller(stage, { version: '1.1.0', file: setup })
    const logged: string[] = []
    await finishUpdate({ target: { layout: 'directory', path: dir, executable: app.exe }, appName: 'App', relaunch: true, installer: handoff, downloadDir, platform: 'linux', log: (l) => logged.push(l) })
    expect(logged.some((l) => l.startsWith(`could not start ${setup}`))).toBe(true)
    expect(await app.read()).toBe(`--wait-for=${process.pid}\n`)
  })
  test('with nothing staged: a restart starts the app, with its arguments; a close does nothing', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'finish-none-'))
    const app = recorder(dir, 'app')
    const target = { layout: 'directory' as const, path: dir, executable: app.exe }
    await finishUpdate({ target, appName: 'App', relaunch: false, installer: handoff, downloadDir: path.join(dir, 'dl'), platform: 'linux' })
    expect(await app.read()).toBeNull()
    await finishUpdate({ target, appName: 'App', relaunch: true, installer: handoff, downloadDir: path.join(dir, 'dl'), platform: 'linux', args: ['--headless'] })
    expect(await app.read()).toBe(`--wait-for=${process.pid} --headless\n`)
  })
  test('an installer an earlier process left under this pid is removed at launch, so the quit runs nothing', async () => {
    // The OS recycles pids: a crash with an update staged, a reboot that kept TEMP, and a later
    // launch can be given the same one. That folder's installer is a version nobody asked for now.
    const dir = fs.mkdtempSync(path.join(tmp, 'finish-stale-'))
    const downloadDir = path.join(dir, 'downloads')
    const app = recorder(dir, 'app')
    const stage = stageDir('App', { downloadDir })
    fs.mkdirSync(stage, { recursive: true })
    const setup = recorder(stage, 'setup')
    writePendingInstaller(stage, { version: '1.1.0', file: setup.exe })
    const target = { layout: 'directory' as const, path: dir, executable: app.exe }
    cleanUpAfterUpdate(target, { appName: 'App', downloadDir })
    expect(fs.existsSync(stage)).toBe(false)
    await finishUpdate({ target, appName: 'App', relaunch: false, installer: handoff, downloadDir, platform: 'linux' })
    expect(await setup.read()).toBeNull()
    expect(await app.read()).toBeNull()
  })
})

describe.skipIf(!posix)('resumeStagedInstall', () => {
  const handoff = { args: ({ installDir, pid, relaunch }: { installDir: string; pid: number; relaunch: boolean }) => [`/DIR=${installDir}`, `/WAITPID=${pid}`, ...(relaunch ? ['/RELAUNCH=1'] : [])] }
  /** A pid that was running a moment ago and is not now. */
  const exitedPid = async () => {
    const gone = Bun.spawn([process.execPath, '-e', '0'])
    await gone.exited
    return gone.pid
  }
  const staged = (downloadDir: string, pid: number, version: string) => {
    const stage = stageDir('App', { pid, downloadDir })
    fs.mkdirSync(stage, { recursive: true })
    const setup = recorder(stage, 'setup')
    writePendingInstaller(stage, { version, file: setup.exe })
    return setup
  }

  test('runs, once, the installer a copy that was killed staged and never ran, told to wait for this one and relaunch', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'resume-'))
    const downloadDir = path.join(dir, 'downloads')
    const setup = staged(downloadDir, await exitedPid(), '1.1.0')
    const resume = () => resumeStagedInstall({ target: { layout: 'directory', path: dir, executable: path.join(dir, 'app') }, appName: 'App', version: '1.0.0', installer: handoff, downloadDir })
    expect(await resume()).toBe(true)
    expect(await setup.read()).toBe(`/DIR=${dir} /WAITPID=${process.pid} /RELAUNCH=1\n`)
    // The install it started may fail and bring this version back: that launch runs nothing.
    expect(await resume()).toBe(false)
  })
  test('the newest of several; never one this version already is or is past, a running copy\'s, or with no way to run it', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'resume-pick-'))
    const downloadDir = path.join(dir, 'downloads')
    const target = { layout: 'directory' as const, path: dir, executable: path.join(dir, 'app') }
    const older = staged(downloadDir, await exitedPid(), '1.1.0')
    const newer = staged(downloadDir, await exitedPid(), '1.2.0')
    expect(await resumeStagedInstall({ target, appName: 'App', version: '1.0.0', installer: handoff, downloadDir })).toBe(true)
    expect(await newer.read()).not.toBeNull()
    expect(await older.read()).toBeNull()

    const quiet = fs.mkdtempSync(path.join(tmp, 'resume-none-'))
    const quietDl = path.join(quiet, 'downloads')
    staged(quietDl, await exitedPid(), '1.0.0')
    const other = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(5000)'])
    try {
      staged(quietDl, other.pid, '2.0.0')
      expect(await resumeStagedInstall({ target, appName: 'App', version: '1.0.0', installer: handoff, downloadDir: quietDl })).toBe(false)
    } finally {
      other.kill()
      await other.exited
    }
    staged(quietDl, await exitedPid(), '1.5.0')
    expect(await resumeStagedInstall({ target, appName: 'App', version: '1.0.0', downloadDir: quietDl })).toBe(false)
    expect(await resumeStagedInstall({ target: null, appName: 'App', version: '1.0.0', installer: handoff, downloadDir: quietDl })).toBe(false)
  })
})

describe('cleanUpAfterUpdate', () => {
  test('removes a bundle copy that was never swapped in, and tolerates its absence', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'clean-'))
    const app = path.join(dir, 'App.app')
    fs.mkdirSync(app)
    fs.mkdirSync(`${app}.new`)
    cleanUpAfterUpdate({ layout: 'bundle', path: app, executable: path.join(app, 'Contents/MacOS/app') })
    expect(fs.readdirSync(dir)).toEqual(['App.app'])
    cleanUpAfterUpdate({ layout: 'bundle', path: app, executable: '' })
    cleanUpAfterUpdate(null)
  })
  test('leaves alone what another running copy is in the middle of, and not what an earlier holder of this pid left', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'clean-live-'))
    const app = path.join(dir, 'App.app')
    fs.mkdirSync(`${app}.new`, { recursive: true })
    const other = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(5000)'])
    try {
      fs.writeFileSync(path.join(`${app}.new`, STAGING_PID), String(other.pid))
      const downloadDir = path.join(dir, 'downloads')
      for (const pid of [other.pid, process.pid]) fs.mkdirSync(stageDir('App', { pid, downloadDir }), { recursive: true })
      cleanUpAfterUpdate({ layout: 'bundle', path: app, executable: '' }, { appName: 'App', downloadDir })
      expect(fs.existsSync(`${app}.new`)).toBe(true)
      expect(fs.readdirSync(downloadDir)).toEqual([`app-update-${other.pid}`])
    } finally {
      other.kill()
      await other.exited
    }
  })
  test('removes the downloads of copies that have exited, and nothing else in the folder', async () => {
    const downloadDir = fs.mkdtempSync(path.join(tmp, 'clean-dl-'))
    const gone = Bun.spawn([process.execPath, '-e', '0'])
    await gone.exited
    fs.mkdirSync(stageDir('App', { pid: gone.pid, downloadDir }))
    fs.writeFileSync(path.join(stageDir('App', { pid: gone.pid, downloadDir }), 'setup.exe'), 'x')
    fs.mkdirSync(path.join(downloadDir, 'app-update-notapid'))
    fs.mkdirSync(path.join(downloadDir, 'other-app-update-1'))
    cleanUpAfterUpdate(null, { appName: 'App', downloadDir })
    expect(fs.readdirSync(downloadDir).sort()).toEqual(['app-update-notapid', 'other-app-update-1'])
  })
})
