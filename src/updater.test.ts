/** The facade: what a check answers, how often it asks, and the install path with the swap stubbed. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MANIFEST_FORMAT } from './manifest'
import { type Release, type ReleaseAsset, type ReleaseSource, staticRelease } from './source'
import { hashTree } from './tree-hash'
import { type InstallEvent, type UpdaterConfig, createUpdater } from './updater'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-facade-'))
const enc = (s: string) => new TextEncoder().encode(s)
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')

/** What a release serves: the manifest and one zip per part, by asset name. */
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

/** The build's parts: `app` (the executable) and `vendor/` (a folder), as a release would ship them. */
const BUILD = { app: 'new exe', 'vendor/ffmpeg': 'ffmpeg bytes', 'vendor/chrome/shell': 'chrome bytes' }
let buildTrees: Record<string, string> = {}
beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'build-'))
  for (const [rel, body] of Object.entries(BUILD)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  buildTrees = { app: (await hashTree(path.join(dir, 'app')))!, vendor: (await hashTree(path.join(dir, 'vendor')))! }
})

interface ReleaseOptions {
  targets?: string[]
  /** Edit the manifest before it is served (and before its hash is taken). */
  edit?: (m: { parts: { name: string; asset: string; size: number; sha256: string; tree: string }[] }) => void
  /** Leave the feed's digest off these assets. */
  noDigest?: string[]
}

/** Publish `version` for each target: serve its parts and manifest, answer the feed's Release. */
const release = (version: string, opts: ReleaseOptions = {}): Release => {
  const assets: ReleaseAsset[] = []
  for (const t of opts.targets ?? ['linux-x64']) {
    const zips = {
      app: zipSync({ app: enc(BUILD.app) }),
      vendor: zipSync({ 'vendor/ffmpeg': enc(BUILD['vendor/ffmpeg']), 'vendor/chrome/shell': enc(BUILD['vendor/chrome/shell']) }),
    }
    const parts = (['app', 'vendor'] as const).map((name) => {
      const asset = `App-${version}-${t}-${name}.zip`
      served.set(asset, zips[name])
      return { name, asset, size: zips[name].length, sha256: sha(zips[name]), tree: buildTrees[name]! }
    })
    const manifest = { format: MANIFEST_FORMAT, version, target: t, parts }
    opts.edit?.(manifest)
    const manifestName = `App-${version}-${t}.manifest.json`
    const manifestBytes = enc(JSON.stringify(manifest))
    served.set(manifestName, manifestBytes)
    for (const name of [manifestName, ...parts.map((p) => p.asset)]) {
      const body = served.get(name)!
      assets.push({ name, url: `${base}/${name}`, size: body.length, sha256: opts.noDigest?.includes(name) ? null : sha(body) })
    }
  }
  return { version, url: `https://x/${version}`, assets }
}

/** An updater that believes it is a Linux install in a scratch dir, with `vendor/` already current. */
const make = (over: Partial<UpdaterConfig> = {}, install: Partial<typeof BUILD> = { app: 'old exe', 'vendor/ffmpeg': BUILD['vendor/ffmpeg'], 'vendor/chrome/shell': BUILD['vendor/chrome/shell'] }) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'install-'))
  for (const [rel, body] of Object.entries(install)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  return createUpdater({
    appName: 'App',
    version: '1.0.0',
    // Only published when the test brings no feed of its own: publishing re-serves the assets.
    source: over.source ?? staticRelease(release('1.1.0')),
    manifestName: (v, t) => `App-${v}-${t}.manifest.json`,
    platform: 'linux',
    arch: 'x64',
    // Forward slashes: the target is resolved by the faked platform's rules (POSIX), and
    // Windows accepts them, so the test passes on both.
    execPath: path.join(dir, 'app').replace(/\\/g, '/'),
    downloadDir: dir,
    apply: async () => {},
    ...over,
  })
}

describe('check', () => {
  test('a newer release: only the parts whose content differs are counted', async () => {
    const info = await make().check()
    const appZip = served.get('App-1.1.0-linux-x64-app.zip')!.length
    expect(info).toEqual({ current: '1.0.0', target: 'linux-x64', latest: { version: '1.1.0', url: 'https://x/1.1.0', size: appZip, parts: ['app'] }, installed: null, blocked: null })
  })
  test('a part the install lacks, or has changed, is counted too', async () => {
    const info = await make({}, { app: 'old exe', 'vendor/ffmpeg': 'older ffmpeg' }).check()
    expect(info.latest?.parts).toEqual(['app', 'vendor'])
    expect((await make({}, { app: 'old exe' }).check()).latest?.parts).toEqual(['app', 'vendor'])
  })
  test('not newer, not this target, nothing published, or from source', async () => {
    expect((await make({ source: staticRelease(release('1.0.0')) }).check()).latest).toBeNull()
    expect((await make({ source: staticRelease(release('0.9.0')) }).check()).latest).toBeNull()
    expect((await make({ source: staticRelease(release('1.1.0', { targets: ['windows-x64'] })) }).check()).latest).toBeNull()
    expect((await make({ source: staticRelease(null) }).check()).latest).toBeNull()
    const fromSource = await make({ execPath: '/usr/local/bin/bun' }).check()
    expect(fromSource.latest?.version).toBe('1.1.0')
    expect(fromSource.latest?.parts).toEqual(['app', 'vendor']) // nothing to compare with
    expect(fromSource.blocked).toMatch(/from source/)
  })
  test('a manifest the feed lists no digest for is still offered, with no size; the install says why', async () => {
    const u = make({ source: staticRelease(release('1.1.0', { noDigest: ['App-1.1.0-linux-x64.manifest.json'] })) })
    expect((await u.check()).latest).toEqual({ version: '1.1.0', url: 'https://x/1.1.0', size: 0, parts: [] })
    const err = await u.install({ onEvent: () => {} }).catch((e) => e)
    expect(err.code).toBe('unverified')
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
  test('a failed background check offers nothing; a failed forced check says why', async () => {
    const source: ReleaseSource = {
      latest: async () => {
        throw new Error('no network')
      },
    }
    const u = make({ source })
    expect((await u.check()).latest).toBeNull()
    await expect(u.check({ force: true })).rejects.toThrow(/no network/)
  })
})

describe('install', () => {
  const collect = () => {
    const events: InstallEvent[] = []
    return { events, onEvent: (e: InstallEvent) => events.push(e) }
  }
  test('downloads the stale parts only, verifies, applies, remembers, and then refuses to run again', async () => {
    const applied: { zips: string[]; parts: string[]; layout: string } = { zips: [], parts: [], layout: '' }
    const u = make({
      apply: async (zips, parts, target, onEvent) => {
        applied.zips = zips
        applied.parts = parts.map((p) => p.name)
        applied.layout = target.layout
        onEvent({ type: 'swapping' })
      },
    })
    const { events, onEvent } = collect()
    expect(await u.install({ onEvent })).toEqual({ version: '1.1.0' })
    expect(events.map((e) => e.type)).toEqual(['checking', 'downloading', 'downloading', 'verifying', 'unpacking', 'swapping', 'done'])
    expect(events.at(-1)).toEqual({ type: 'done', ok: true, version: '1.1.0' })
    expect(applied.parts).toEqual(['app'])
    expect(applied.layout).toBe('directory')
    expect(applied.zips).toHaveLength(1)
    expect(fs.existsSync(applied.zips[0]!)).toBe(false) // the download is removed afterwards
    expect(u.installedVersion()).toBe('1.1.0')
    expect((await u.check()).installed).toBe('1.1.0')
    const again = await u.install({ onEvent: () => {} }).catch((e) => e)
    expect(again.code).toBe('already_installed')
  })
  test('several parts download as one progress bar, in the manifest\'s order', async () => {
    let parts: string[] = []
    const u = make({ apply: async (_z, p) => void (parts = p.map((x) => x.name)) }, { app: 'old', 'vendor/ffmpeg': 'old' })
    const { events, onEvent } = collect()
    await u.install({ onEvent })
    const total = served.get('App-1.1.0-linux-x64-app.zip')!.length + served.get('App-1.1.0-linux-x64-vendor.zip')!.length
    const downloading = events.filter((e) => e.type === 'downloading') as { received: number; total: number }[]
    expect(downloading.every((e) => e.total === total)).toBe(true)
    expect(downloading.at(-1)?.received).toBe(total)
    expect(downloading.every((e, i) => i === 0 || e.received >= downloading[i - 1]!.received)).toBe(true)
    expect(parts).toEqual(['app', 'vendor'])
  })
  test('refuses while busy, from source, with no update, and a damaged download', async () => {
    const code = async (u: ReturnType<typeof make>) => (await u.install({ onEvent: () => {} }).catch((e) => e)).code
    expect(await code(make({ busy: () => 'a video is being made' }))).toBe('busy')
    expect(await code(make({ execPath: '/usr/local/bin/bun' }))).toBe('blocked')
    expect(await code(make({ source: staticRelease(release('1.0.0')) }))).toBe('no_update')
    // The manifest says the app zip hashes to something it does not: the bytes are refused.
    const bad = release('1.1.0', { edit: (m) => (m.parts[0]!.sha256 = '0'.repeat(64)) })
    expect(await code(make({ source: staticRelease(bad) }))).toBe('damaged')
  })
  test('a manifest that disagrees with the feed, or lacks the executable, is refused before anything downloads', async () => {
    const code = async (u: ReturnType<typeof make>) => (await u.install({ onEvent: () => {} }).catch((e) => e))
    // The feed's digest for the zip stays right; the manifest's is wrong: they disagree.
    const disagree = release('1.1.0', { edit: (m) => (m.parts[1]!.sha256 = '1'.repeat(64)) })
    expect((await code(make({ source: staticRelease(disagree) }))).message).toMatch(/disagree/)
    const noExe = release('1.1.0', { edit: (m) => (m.parts[0]!.name = 'other') })
    expect((await code(make({ source: staticRelease(noExe) }))).message).toMatch(/isn't a App build/)
  })
  test('a job that starts during the download stops the swap', async () => {
    let busy: string | null = null
    const u = make({ busy: () => busy, apply: async () => {} })
    const err = await u.install({ onEvent: (e) => e.type === 'verifying' && (busy = 'a render is in flight') }).catch((e) => e)
    expect(err.code).toBe('busy')
    expect(u.installedVersion()).toBeNull()
  })
  test('a second install while one runs is refused, and the done event carries failures', async () => {
    let release_: (() => void) | null = null
    const u = make({ apply: () => new Promise<void>((r) => (release_ = r)) })
    const first = u.install({ onEvent: () => {} })
    await Bun.sleep(50)
    const { events, onEvent } = collect()
    const second = await u.install({ onEvent }).catch((e) => e)
    expect(second.code).toBe('in_progress')
    expect(events).toEqual([{ type: 'done', ok: false, code: 'in_progress', message: 'An update is already being installed.' }])
    release_!()
    await first
  })
})
