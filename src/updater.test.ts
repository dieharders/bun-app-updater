/** The facade: what a check answers, how often it asks, and the install path with the swap stubbed. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pendingInstaller } from './relaunch'
import { type Release, type ReleaseAsset, ReleaseFeedError, type ReleaseSource, staticRelease } from './source'
import { freeBytes } from './target'
import { type InstallEvent, type UpdaterConfig, createUpdater } from './updater'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-facade-'))
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')

/** What a release serves, by asset name. */
const served = new Map<string, Uint8Array>()
let server: ReturnType<typeof Bun.serve>
let base = ''
beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      const body = served.get(new URL(req.url).pathname.slice(1))
      return body ? new Response(new Uint8Array(body)) : new Response('nope', { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => {
  server.stop(true)
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** The download a target installs from, as MyApp names them. */
const assetName = (_v: string, t: string): string | null =>
  t.startsWith('darwin') ? `App-${t}.dmg` : t.startsWith('windows') ? `App-${t}-setup.exe` : t.startsWith('linux') ? `app-${t}.deb` : null

interface ReleaseOptions {
  targets?: string[]
  /** Leave the feed's digest off these assets. */
  noDigest?: string[]
  /** Have the feed list a wrong digest for these. */
  badDigest?: string[]
  /** Have the feed list this size for every asset. */
  size?: number
}

/** Publish `version`: serve one download per target, answer the feed's Release. */
const release = (version: string, opts: ReleaseOptions = {}): Release => {
  const assets: ReleaseAsset[] = []
  for (const t of opts.targets ?? ['darwin-arm64', 'windows-x64', 'linux-x64']) {
    const name = assetName(version, t)!
    const body = new TextEncoder().encode(`${name} ${version}`)
    served.set(name, body)
    const digest = opts.badDigest?.includes(name) ? '0'.repeat(64) : sha(body)
    assets.push({ name, url: `${base}/${name}`, size: opts.size ?? body.length, sha256: opts.noDigest?.includes(name) ? null : digest })
  }
  return { version, url: `https://x/${version}`, assets }
}

const quiet = { log: () => {} }

/** An updater that believes it is MyApp 1.0.0 installed as a macOS bundle in a scratch folder. */
const make = (over: Partial<UpdaterConfig> = {}) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'install-'))
  const exe = path.join(dir, 'App.app', 'Contents', 'MacOS', 'app')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'old')
  return createUpdater({
    appName: 'App',
    version: '1.0.0',
    source: staticRelease(release('1.1.0')),
    assetName,
    platform: 'darwin',
    arch: 'arm64',
    // Forward slashes, as in makeWindows: a macOS path is split by POSIX rules, which do not
    // split a Windows host's `\` (and the scratch folder is still writable that way).
    execPath: exe.replace(/\\/g, '/'),
    downloadDir: path.join(dir, 'downloads'),
    apply: async () => {},
    // Quiet: without a log, failures go to console.warn, and these tests fail installs on purpose.
    ...quiet,
    ...over,
  })
}

/** The same, installed as a Windows directory with an installer to run. */
const makeWindows = (over: Partial<UpdaterConfig> = {}) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'win-'))
  fs.writeFileSync(path.join(dir, 'app.exe'), 'old')
  return make({
    platform: 'win32',
    arch: 'x64',
    // Forward slashes: the target is resolved by the faked platform's rules, and Windows accepts them.
    execPath: path.join(dir, 'app.exe').replace(/\\/g, '/'),
    downloadDir: path.join(dir, 'downloads'),
    installer: { args: ({ installDir, pid, relaunch }) => ['/SILENT', `/DIR=${installDir}`, `/WAITPID=${pid}`, ...(relaunch ? ['/RELAUNCH=1'] : [])] },
    ...over,
  })
}

/** A feed that counts its asks, and a `checkFile` of its own. */
const counted = (answer: () => Release | null = () => release('1.1.0')) => {
  const feed: { calls: number; source: ReleaseSource } = { calls: 0, source: { latest: async () => (feed.calls++, answer()) } }
  return { feed, checkFile: path.join(fs.mkdtempSync(path.join(tmp, 'check-')), 'nested', 'update-check.json') }
}

/** Run `fn` with the clock `ms` ahead. */
const later = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
  const now = Date.now
  Date.now = () => now() + ms
  try {
    return await fn()
  } finally {
    Date.now = now
  }
}

describe('the saved check', () => {
  test('a restart inside the TTL does not ask the feed, and still offers what it found', async () => {
    const { feed, checkFile } = counted()
    await make({ source: feed.source, checkFile }).check()
    expect(feed.calls).toBe(1)
    const restarted = make({ source: feed.source, checkFile })
    expect(await restarted.check()).toMatchObject({ latest: { version: '1.1.0' }, checkFailed: false, checkPending: false })
    expect(feed.calls).toBe(1)
    expect(restarted.lastRelease()?.version).toBe('1.1.0') // what the release page is opened from
  })
  test('a restart past the TTL asks the feed', async () => {
    const { feed, checkFile } = counted()
    await make({ source: feed.source, checkFile, checkTtlMs: 60_000 }).check()
    await later(61_000, () => make({ source: feed.source, checkFile, checkTtlMs: 60_000 }).check())
    expect(feed.calls).toBe(2)
  })
  test('"nothing published" is an answer too: it holds the feed off just the same', async () => {
    const { feed, checkFile } = counted(() => null)
    await make({ source: feed.source, checkFile }).check()
    await make({ source: feed.source, checkFile }).check()
    expect(feed.calls).toBe(1)
  })
  test('a failed ask counts as the check, and what was known stands: that launch and the next still offer it', async () => {
    const { feed, checkFile } = counted()
    await make({ source: feed.source, checkFile, checkTtlMs: 60_000 }).check()
    const failing: ReleaseSource = {
      latest: async () => {
        throw new ReleaseFeedError('rate limited', 'rate_limited')
      },
    }
    const refused = await later(61_000, () => make({ source: failing, checkFile, checkTtlMs: 60_000 }).check())
    expect(refused).toMatchObject({ latest: { version: '1.1.0' }, checkFailed: true })
    const next = await later(62_000, () => make({ source: feed.source, checkFile, checkTtlMs: 60_000 }).check())
    expect(next).toMatchObject({ latest: { version: '1.1.0' }, checkFailed: true })
    expect(feed.calls).toBe(1) // inside the TTL of the failed ask
  })
  test('a saved failure is not an answer: a forced check asks at once, inside the floor', async () => {
    const { feed, checkFile } = counted()
    const failing: ReleaseSource = {
      latest: async () => {
        throw new ReleaseFeedError('rate limited', 'rate_limited')
      },
    }
    await make({ source: failing, checkFile }).check()
    const restarted = make({ source: feed.source, checkFile })
    expect(await restarted.check({ force: true })).toMatchObject({ latest: { version: '1.1.0' }, checkFailed: false })
    expect(feed.calls).toBe(1)
  })
  test('an ask that never reached the feed saves nothing: the next launch asks', async () => {
    const { feed, checkFile } = counted()
    const options = { checkFile, checkTtlMs: 60_000, oncePerLaunch: true }
    await make({ ...options, source: feed.source }).check()
    const saved = fs.readFileSync(checkFile, 'utf8')
    const offline: ReleaseSource = {
      latest: async () => {
        throw new ReleaseFeedError('unreachable', 'offline')
      },
    }
    await later(61_000, () => make({ ...options, source: offline }).check())
    expect(fs.readFileSync(checkFile, 'utf8')).toBe(saved)
    await later(62_000, () => make({ ...options, source: feed.source }).check())
    expect(feed.calls).toBe(2)
  })
  test('a file that cannot be trusted counts as no check: unreadable, the wrong shape, or from the future', async () => {
    for (const body of ['{"at":', '{"at":"soon","release":null}', '{"at":1}', '{"at":1,"release":{"version":"x","assets":[]}}', JSON.stringify({ at: Date.now() + 3_600_000, release: null })]) {
      const { feed, checkFile } = counted()
      fs.mkdirSync(path.dirname(checkFile), { recursive: true })
      fs.writeFileSync(checkFile, body)
      await make({ source: feed.source, checkFile }).check()
      expect(feed.calls).toBe(1)
    }
  })
  test('a file that cannot be written only costs the next launch an ask', async () => {
    const { feed, checkFile } = counted()
    fs.mkdirSync(checkFile, { recursive: true }) // a folder where the file goes
    const logged: string[] = []
    const info = await make({ source: feed.source, checkFile, log: (line) => logged.push(line) }).check()
    expect(info.latest?.version).toBe('1.1.0')
    expect(logged.some((line) => line.startsWith('could not save the check'))).toBe(true)
    expect(fs.readdirSync(path.dirname(checkFile))).toEqual([path.basename(checkFile)])
  })
})

describe('the first check after launch', () => {
  test('a background check leaves the feed alone until the delay is over, and says so', async () => {
    const { feed } = counted()
    const u = make({ source: feed.source, firstCheckDelayMs: 60_000 })
    expect(await u.check()).toMatchObject({ latest: null, checkPending: true, checkFailed: false })
    expect(feed.calls).toBe(0)
    expect(await later(59_000, () => u.check())).toMatchObject({ checkPending: true })
    expect(feed.calls).toBe(0)
    expect(await later(61_000, () => u.check())).toMatchObject({ latest: { version: '1.1.0' }, checkPending: false })
    expect(feed.calls).toBe(1)
  })
  test('a stale saved answer is shown meanwhile, and the ask stays due', async () => {
    const { feed, checkFile } = counted()
    const options = { source: feed.source, checkFile, checkTtlMs: 60_000, firstCheckDelayMs: 60_000 }
    await later(-120_000, () => make(options).check({ force: true }))
    expect(feed.calls).toBe(1)
    const u = make(options)
    expect(await u.check()).toMatchObject({ latest: { version: '1.1.0' }, checkPending: true })
    expect(feed.calls).toBe(1)
    await later(61_000, () => u.check())
    expect(feed.calls).toBe(2)
  })
  test('nothing is pending when the saved answer is fresh: the delay has nothing to hold back', async () => {
    const { feed, checkFile } = counted()
    await make({ source: feed.source, checkFile }).check()
    const u = make({ source: feed.source, checkFile, firstCheckDelayMs: 60_000 })
    expect(await u.check()).toMatchObject({ latest: { version: '1.1.0' }, checkPending: false })
    expect(feed.calls).toBe(1)
  })
  test('a forced check is someone asking: it does not wait, and its answer is saved', async () => {
    const { feed, checkFile } = counted()
    const u = make({ source: feed.source, checkFile, firstCheckDelayMs: 60_000 })
    expect(await u.check({ force: true })).toMatchObject({ latest: { version: '1.1.0' }, checkPending: false })
    expect(feed.calls).toBe(1)
    expect(JSON.parse(fs.readFileSync(checkFile, 'utf8')).release.version).toBe('1.1.0')
  })
})

describe('one ask a launch', () => {
  const failing = (): ReleaseSource & { calls: number } => {
    const feed = {
      calls: 0,
      latest: async () => {
        feed.calls++
        throw new ReleaseFeedError('rate limited', 'rate_limited')
      },
    }
    return feed
  }

  test('past the TTL, a running copy does not ask again however often a page asks', async () => {
    const { feed } = counted()
    const u = make({ source: feed.source, checkTtlMs: 60_000, oncePerLaunch: true })
    await u.check()
    expect(await later(3_600_000, () => u.check())).toMatchObject({ latest: { version: '1.1.0' }, checkPending: false })
    await later(7_200_000, () => u.check())
    expect(feed.calls).toBe(1)
  })
  test('a failed ask is not repeated, and the answer goes on saying it failed', async () => {
    const source = failing()
    const u = make({ source, oncePerLaunch: true })
    await u.check()
    expect(await later(61_000, () => u.check())).toMatchObject({ checkFailed: true, checkPending: false })
    expect(source.calls).toBe(1)
  })
  test('a failure saved by the last launch holds the next one off until the TTL is over', async () => {
    const { checkFile } = counted()
    const source = failing()
    const options = { source, checkFile, firstCheckDelayMs: 60_000, oncePerLaunch: true }
    await make(options).check({ force: true }).catch(() => {})
    expect(await later(120_000, () => make(options).check())).toMatchObject({ checkFailed: true, checkPending: false })
    expect(source.calls).toBe(1)
  })
  test('a launch with a fresh answer has its ask left, if anything still asks once that answer goes stale', async () => {
    const { feed, checkFile } = counted()
    const options = { source: feed.source, checkFile, checkTtlMs: 60_000, oncePerLaunch: true }
    await make(options).check()
    const u = make(options)
    await u.check()
    expect(feed.calls).toBe(1)
    await later(61_000, () => u.check())
    await later(122_000, () => u.check())
    expect(feed.calls).toBe(2)
  })
  test('someone asking is not limited, and it uses up the launch\'s ask', async () => {
    const { feed } = counted()
    const u = make({ source: feed.source, checkTtlMs: 60_000, oncePerLaunch: true })
    await u.check({ force: true })
    await later(61_000, () => u.check({ force: true }))
    expect(feed.calls).toBe(2)
    await later(200_000, () => u.check())
    expect(feed.calls).toBe(2)
  })
})

describe('check', () => {
  test('a newer release with a download for this target is offered, with that download\'s size', async () => {
    const info = await make().check()
    expect(info).toEqual({ current: '1.0.0', target: 'darwin-arm64', latest: { version: '1.1.0', url: 'https://x/1.1.0', size: served.get('App-darwin-arm64.dmg')!.length }, installed: null, blocked: null, checkFailed: false, checkPending: false })
  })
  test('not newer, not this target, nothing published', async () => {
    expect((await make({ source: staticRelease(release('1.0.0')) }).check()).latest).toBeNull()
    expect((await make({ source: staticRelease(release('0.9.0')) }).check()).latest).toBeNull()
    expect((await make({ source: staticRelease(release('1.1.0', { targets: ['windows-x64'] })) }).check()).latest).toBeNull()
    expect((await make({ source: staticRelease(null) }).check()).latest).toBeNull()
  })
  test('where it cannot install in place it still offers the release, and says why: source, Linux, Windows with no installer', async () => {
    const fromSource = await make({ execPath: '/usr/local/bin/bun' }).check()
    expect(fromSource.latest?.version).toBe('1.1.0')
    expect(fromSource.blocked).toMatch(/from source/)
    const dir = fs.mkdtempSync(path.join(tmp, 'linux-'))
    const linux = await make({ platform: 'linux', arch: 'x64', execPath: path.join(dir, 'app') }).check()
    expect(linux.latest?.version).toBe('1.1.0')
    expect(linux.blocked).toBe("App can't install updates by itself on Linux. Download the update instead.")
    expect((await makeWindows({ installer: undefined }).check()).blocked).toMatch(/by itself on Windows/)
    expect((await makeWindows().check()).blocked).toBeNull()
  })
  test('a download too big for the disk is offered as blocked', async () => {
    const info = await make({ source: staticRelease(release('1.1.0', { size: Number.MAX_SAFE_INTEGER / 8 })) }).check()
    expect(info.latest?.version).toBe('1.1.0')
    expect(info.blocked).toMatch(/disk space/)
  })
  test('an installer needs room for its download and the whole new copy beside the old one, not twice the download', async () => {
    // A third of the free space: twice it fits, and the ~3.5x an installer really writes does not.
    const probe = makeWindows()
    const free = freeBytes(path.dirname(probe.target()!.path))!
    const info = await makeWindows({ source: staticRelease(release('1.1.0', { size: Math.floor(free / 3) })) }).check()
    expect(info.blocked).toMatch(/disk space/)
  })
  test("the app's own reason blocks it too, and is asked on every check, not cached with the feed's answer", async () => {
    let reason: string | null = 'App installs updates from its window.'
    const u = make({ blocked: () => reason })
    expect((await u.check()).blocked).toBe('App installs updates from its window.')
    reason = null
    expect((await u.check()).blocked).toBeNull()
    // The updater's own reasons come first: from source says more than "no window".
    expect((await make({ execPath: '/usr/local/bin/bun', blocked: () => 'no window' }).check()).blocked).toMatch(/from source/)
  })
  test('asks the feed once per TTL however often the page asks; force asks again after the floor', async () => {
    let calls = 0
    const source: ReleaseSource = { latest: async () => (calls++, release('1.1.0')) }
    const u = make({ source, checkTtlMs: 60_000 })
    await Promise.all([u.check(), u.check(), u.check()])
    await u.check()
    expect(calls).toBe(1)
    await u.check({ force: true })
    expect(calls).toBe(1) // inside the 60s floor
  })
  test('a failed check is asked again a minute later, forced or not, not after the whole TTL', async () => {
    let calls = 0
    const source: ReleaseSource = {
      latest: async () => {
        if (calls++ === 0) throw new ReleaseFeedError('offline', 'offline')
        return release('1.1.0')
      },
    }
    const u = make({ source })
    // Said as a failure, not as "no update": a page asks again sooner for it.
    expect(await u.check()).toMatchObject({ latest: null, checkFailed: true })
    expect(await u.check()).toMatchObject({ latest: null, checkFailed: true }) // inside the floor: the failure stands
    expect(calls).toBe(1)
    const now = Date.now
    Date.now = () => now() + 61_000
    try {
      expect(await u.check()).toMatchObject({ latest: { version: '1.1.0' }, checkFailed: false })
    } finally {
      Date.now = now
    }
    expect(calls).toBe(2)
  })
  test('the write probe runs once per ask of the feed, not on every check a page makes', async () => {
    const written: string[] = []
    const probes = () => written.filter((p) => p.includes('-write-test-')).length
    const real = fs.writeFileSync
    const counting = spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      written.push(String(file))
      return (real as (...a: unknown[]) => void)(file, ...rest)
    }) as typeof fs.writeFileSync)
    try {
      const u = make()
      for (let i = 0; i < 5; i++) await u.check()
      expect(probes()).toBe(1)
      const now = Date.now
      Date.now = () => now() + 61_000
      try {
        await u.check({ force: true }) // the feed asked again: so is the folder
      } finally {
        Date.now = now
      }
      expect(probes()).toBe(2)
    } finally {
      counting.mockRestore()
    }
  })
  test('a failed background check offers nothing; a failed forced check says why, in the feed\'s words only', async () => {
    const logged: string[] = []
    const raw: ReleaseSource = {
      latest: async () => {
        throw new Error('ECONNRESET 140.82.112.6:443')
      },
    }
    const u = make({ source: raw, log: (line) => logged.push(line) })
    expect((await u.check()).latest).toBeNull()
    // A raw error is not shown; it is logged.
    const err = await u.check({ force: true }).catch((e) => e)
    expect(err).toBeInstanceOf(ReleaseFeedError)
    expect(err.message).toBe('The release feed could not be reached. Check your connection and try again.')
    expect(logged.some((l) => l.includes('ECONNRESET'))).toBe(true)
    // A ReleaseFeedError is written to be shown, and is.
    const feed: ReleaseSource = {
      latest: async () => {
        throw new ReleaseFeedError('GitHub is turning away update requests for now. Try again in an hour.', 'rate_limited')
      },
    }
    await expect(make({ source: feed }).check({ force: true })).rejects.toThrow(/turning away/)
  })
  test('a page that drops its check neither caches a failure nor fails anyone else', async () => {
    let calls = 0
    const source: ReleaseSource = {
      latest: async (signal) => {
        calls++
        await Bun.sleep(30)
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        return release('1.1.0')
      },
    }
    const u = make({ source })
    const dropped = new AbortController()
    const first = u.check({ signal: dropped.signal })
    const second = u.check()
    dropped.abort()
    expect((await first.catch((e) => e)).code).toBe('cancelled')
    expect((await second).latest?.version).toBe('1.1.0')
    // And the answer is the one cached: the next page sees the update too, without asking again.
    expect((await u.check()).latest?.version).toBe('1.1.0')
    expect(calls).toBe(1)
  })
})

describe('install', () => {
  const collect = () => {
    const events: InstallEvent[] = []
    return { events, onEvent: (e: InstallEvent) => events.push(e) }
  }
  const code = async (u: ReturnType<typeof make>) => (await u.install({ onEvent: () => {} }).catch((e) => e)).code

  test('macOS: downloads the DMG, verifies it, swaps, remembers, removes the download, and refuses to run again', async () => {
    let applied: { file: string; bytes: string; layout: string } | null = null
    const u = make({
      apply: async (file, target, onEvent) => {
        applied = { file, bytes: fs.readFileSync(file, 'utf8'), layout: target.layout }
        onEvent({ type: 'swapping' })
      },
    })
    const { events, onEvent } = collect()
    expect(await u.install({ onEvent })).toEqual({ version: '1.1.0' })
    expect(events.map((e) => e.type)).toEqual(['checking', 'downloading', 'downloading', 'verifying', 'unpacking', 'swapping', 'done'])
    // Indeterminate: the unpack reports no progress, and `0 of 1` drew an empty bar.
    expect(events.find((e) => e.type === 'unpacking')).toEqual({ type: 'unpacking', done: 0, total: 0 })
    expect(events.at(-1)).toEqual({ type: 'done', ok: true, version: '1.1.0' })
    expect(applied!).toMatchObject({ bytes: 'App-darwin-arm64.dmg 1.1.0', layout: 'bundle' })
    expect(fs.existsSync(path.dirname(applied!.file))).toBe(false) // the download and its folder are gone
    expect(u.installedVersion()).toBe('1.1.0')
    expect((await u.check()).installed).toBe('1.1.0')
    expect(await code(u)).toBe('already_installed')
  })
  test('Windows: downloads and verifies the installer and stages it for the quit; nothing is applied', async () => {
    let applied = false
    const downloadDir = fs.mkdtempSync(path.join(tmp, 'win-dl-'))
    const u = makeWindows({ downloadDir, apply: async () => void (applied = true) })
    const { events, onEvent } = collect()
    expect(await u.install({ onEvent })).toEqual({ version: '1.1.0' })
    expect(events.map((e) => e.type)).toEqual(['checking', 'downloading', 'downloading', 'verifying', 'done'])
    expect(applied).toBe(false)
    const pending = pendingInstaller('App', { downloadDir })
    expect(pending?.version).toBe('1.1.0')
    expect(fs.readFileSync(pending!.file, 'utf8')).toBe('App-windows-x64-setup.exe 1.1.0')
    expect(u.installedVersion()).toBe('1.1.0')
    // A cleanUp() after the install leaves the staged installer for the quit.
    u.cleanUp()
    expect(pendingInstaller('App', { downloadDir })?.version).toBe('1.1.0')
  })
  test('refuses while busy, from source, on Linux, with no update, and too big for the disk', async () => {
    expect(await code(make({ busy: () => 'a video is being made' }))).toBe('busy')
    expect(await code(make({ execPath: '/usr/local/bin/bun' }))).toBe('blocked')
    expect(await code(make({ blocked: () => 'App installs updates from its window.' }))).toBe('blocked')
    const dir = fs.mkdtempSync(path.join(tmp, 'linux-'))
    expect(await code(make({ platform: 'linux', arch: 'x64', execPath: path.join(dir, 'app') }))).toBe('blocked')
    expect(await code(make({ source: staticRelease(release('1.0.0')) }))).toBe('no_update')
    expect(await code(make({ source: staticRelease(release('1.1.0', { targets: ['windows-x64'] })) }))).toBe('no_update')
    expect(await code(make({ source: staticRelease(release('1.1.0', { size: Number.MAX_SAFE_INTEGER / 8 })) }))).toBe('blocked')
  })
  test('a download the feed lists no checksum for is refused, and one that does not match it is damaged; neither is applied', async () => {
    let applied = false
    const apply = async () => void (applied = true)
    expect(await code(make({ apply, source: staticRelease(release('1.1.0', { noDigest: ['App-darwin-arm64.dmg'] })) }))).toBe('unverified')
    expect(await code(make({ apply, source: staticRelease(release('1.1.0', { badDigest: ['App-darwin-arm64.dmg'] })) }))).toBe('damaged')
    const downloadDir = fs.mkdtempSync(path.join(tmp, 'win-bad-'))
    expect(await code(makeWindows({ downloadDir, source: staticRelease(release('1.1.0', { badDigest: ['App-windows-x64-setup.exe'] })) }))).toBe('damaged')
    expect(applied).toBe(false)
    expect(pendingInstaller('App', { downloadDir })).toBeNull()
    expect(fs.readdirSync(downloadDir)).toEqual([])
  })
  test('a job that starts during the download stops the swap, and the installer is not staged', async () => {
    let busy: string | null = null
    const u = make({ busy: () => busy })
    const err = await u.install({ onEvent: (e) => e.type === 'verifying' && (busy = 'a render is in flight') }).catch((e) => e)
    expect(err.code).toBe('busy')
    expect(u.installedVersion()).toBeNull()
    busy = null
    const downloadDir = fs.mkdtempSync(path.join(tmp, 'win-busy-'))
    const w = makeWindows({ downloadDir, busy: () => busy })
    expect((await w.install({ onEvent: (e) => e.type === 'verifying' && (busy = 'a video is being made') }).catch((e) => e)).code).toBe('busy')
    expect(pendingInstaller('App', { downloadDir })).toBeNull()
  })
  test('an unexpected failure shows the user a plain message; the raw one goes to the log', async () => {
    const logged: string[] = []
    const raw = "EACCES: permission denied, rename '/Applications/App.app.new/App.app' -> '/Applications/App.app'"
    const u = make({
      log: (line) => logged.push(line),
      apply: async () => {
        throw new Error(raw)
      },
    })
    const { events, onEvent } = collect()
    const err = await u.install({ onEvent }).catch((e) => e)
    expect(err.code).toBe('swap_failed')
    expect(err.message).toBe('The update failed. Try again, or download the update instead.')
    expect(events.at(-1)).toEqual({ type: 'done', ok: false, code: 'swap_failed', message: err.message })
    expect(logged.at(-1)).toContain(raw)
  })
  test('with no log, the raw failure still goes somewhere: console.warn', async () => {
    const warned: string[] = []
    const warn = console.warn
    console.warn = (line: string) => void warned.push(line)
    try {
      const u = make({
        log: undefined,
        apply: async () => {
          throw new Error('ENOSPC: no space left on device, write')
        },
      })
      await u.install({ onEvent: () => {} }).catch(() => {})
    } finally {
      console.warn = warn
    }
    expect(warned.some((l) => l.startsWith('[App updater] install failed (swap_failed)') && l.includes('ENOSPC'))).toBe(true)
  })
  test('the install\'s signal reaches the swap, which is what stops a cancelled unpack', async () => {
    let seen: AbortSignal | undefined
    const u = make({ apply: async (_f, _t, _e, signal) => void (seen = signal) })
    const ac = new AbortController()
    await u.install({ onEvent: () => {}, signal: ac.signal })
    expect(seen).toBe(ac.signal)
  })
  test('a second install while one runs is refused, and the done event carries failures', async () => {
    let release_: (() => void) | null = null
    const u = make({ apply: () => new Promise<void>((r) => (release_ = r)) })
    const first = u.install({ onEvent: () => {} })
    await Bun.sleep(50)
    expect(u.installing()).toBe(true)
    const { events, onEvent } = collect()
    const second = await u.install({ onEvent }).catch((e) => e)
    expect(second.code).toBe('in_progress')
    expect(events).toEqual([{ type: 'done', ok: false, code: 'in_progress', message: 'An update is already being installed.' }])
    release_!()
    await first
    expect(u.installing()).toBe(false)
  })
})
