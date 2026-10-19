/** The feeds without a network: an injected fetch answers what GitHub would. */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type Fetch, ReleaseFeedError, githubReleases, jsonRelease } from './source'

/** GitHub answering `/releases/latest` with `release` (one release object, as it does). */
const gh = (release: unknown, status = 200): { fetch: Fetch; urls: string[] } => {
  const urls: string[] = []
  return {
    urls,
    fetch: async (url) => {
      urls.push(url)
      return new Response(JSON.stringify(release), { status })
    },
  }
}
const rel = (tag: string, assets: string[], extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/x/y/releases/tag/${tag}`,
  assets: assets.map((name) => ({ name, browser_download_url: `https://dl/${name}`, size: 10, digest: `sha256:${'a'.repeat(64)}` })),
  ...extra,
})

describe('githubReleases', () => {
  test('asks for the latest release, in one request', async () => {
    const { fetch, urls } = gh(rel('motionbuff-v0.13.23', ['MotionBuff-darwin-arm64.dmg']))
    const src = githubReleases({ repo: 'o/r', tagPrefix: 'motionbuff-v', userAgent: 'T', fetch })
    const latest = await src.latest()
    expect(urls).toEqual(['https://api.github.com/repos/o/r/releases/latest'])
    expect(latest).toEqual({
      version: '0.13.23',
      url: 'https://github.com/x/y/releases/tag/motionbuff-v0.13.23',
      assets: [{ name: 'MotionBuff-darwin-arm64.dmg', url: 'https://dl/MotionBuff-darwin-arm64.dmg', size: 10, sha256: 'a'.repeat(64) }],
    })
  })

  test("a latest release that is not this app's is a feed error, never \"no release\"", async () => {
    // "No release" would read as up to date on every installed copy, for as long as the other
    // release stayed the latest.
    for (const tag of ['v9.9.9', 'motionbuff-vnightly', 'motionbuff-v1.2']) {
      const err = await githubReleases({ repo: 'o/r', tagPrefix: 'motionbuff-v', userAgent: 'T', fetch: gh(rel(tag, ['lib.tgz'])).fetch })
        .latest()
        .catch((e) => e)
      expect(err).toBeInstanceOf(ReleaseFeedError)
      expect(err.code).toBe('bad_feed')
      expect(err.message).toContain(tag)
    }
  })

  test('nothing published, no digest, and the feed refusing', async () => {
    expect(await githubReleases({ repo: 'o/r', tagPrefix: 'v', userAgent: 'T', fetch: gh({ message: 'Not Found' }, 404).fetch }).latest()).toBeNull()
    for (const shape of [[], null, { name: 'no tag' }]) {
      const err = await githubReleases({ repo: 'o/r', tagPrefix: 'v', userAgent: 'T', fetch: gh(shape).fetch }).latest().catch((e) => e)
      expect(err.code).toBe('bad_feed')
    }
    const noDigest = { ...rel('v1.0.0', ['a']), assets: [{ name: 'a', browser_download_url: 'u', size: 1 }] }
    expect((await githubReleases({ repo: 'o/r', tagPrefix: 'v', userAgent: 'T', fetch: gh(noDigest).fetch }).latest())?.assets[0]?.sha256).toBeNull()
    await expect(githubReleases({ repo: 'o/r', tagPrefix: 'v', userAgent: 'T', fetch: gh({}, 403).fetch }).latest()).rejects.toThrow(/turning away/)
    const offline: Fetch = async () => {
      throw new TypeError('fetch failed')
    }
    const err = await githubReleases({ repo: 'o/r', tagPrefix: 'v', userAgent: 'T', fetch: offline }).latest().catch((e) => e)
    expect(err).toBeInstanceOf(ReleaseFeedError)
    expect(err.code).toBe('offline')
  })

  test('a body that is not JSON (a captive portal) or that times out half way is a feed error, not a raw one', async () => {
    const portal: Fetch = async () => new Response('<html>Sign in to the hotel Wi-Fi</html>', { status: 200 })
    const bad = await githubReleases({ repo: 'o/r', tagPrefix: 'v', userAgent: 'T', fetch: portal }).latest().catch((e) => e)
    expect(bad).toBeInstanceOf(ReleaseFeedError)
    expect(bad.code).toBe('bad_feed')
    // Headers arrive, then the body stalls past the timeout.
    const stalls: Fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('['))
            init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason))
          },
        }),
      )
    const slow = await githubReleases({ repo: 'o/r', tagPrefix: 'v', userAgent: 'T', fetch: stalls, timeoutMs: 50 }).latest().catch((e) => e)
    expect(slow).toBeInstanceOf(ReleaseFeedError)
    expect(slow.code).toBe('offline')
  })
})

describe('jsonRelease', () => {
  test('a manifest from a file: URL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-feed-'))
    const file = path.join(dir, 'release.json')
    fs.writeFileSync(file, JSON.stringify({ version: '1.2.3', url: 'https://notes', assets: [{ name: 'A-1.2.3-linux-x64.zip', url: 'http://127.0.0.1:1/a.zip', size: 5, sha256: 'B'.repeat(64) }] }))
    const latest = await jsonRelease(Bun.pathToFileURL(file).href).latest()
    expect(latest?.version).toBe('1.2.3')
    expect(latest?.assets[0]?.sha256).toBe('b'.repeat(64))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  test('a manifest over http, and one that is not a release', async () => {
    const ok: Fetch = async () => new Response(JSON.stringify({ version: '2.0.0', assets: [] }))
    expect((await jsonRelease('http://127.0.0.1:1/r.json', ok).latest())?.version).toBe('2.0.0')
    const bad: Fetch = async () => new Response('{"version":"two"}')
    await expect(jsonRelease('http://127.0.0.1:1/r.json', bad).latest()).rejects.toThrow(/expected shape/)
    const missing: Fetch = async () => new Response('', { status: 404 })
    expect(await jsonRelease('http://127.0.0.1:1/r.json', missing).latest()).toBeNull()
  })
})
