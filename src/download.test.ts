/** Downloads against a loopback server: complete, short, damaged, cancelled. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadTo } from './download'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-dl-'))
const body = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251)
const sha = createHash('sha256').update(body).digest('hex')
let server: ReturnType<typeof Bun.serve>
let base = ''

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname
      if (p === '/ok') return new Response(body)
      if (p === '/short') return new Response(body.subarray(0, 1000), { headers: { 'content-length': String(body.length) } })
      if (p === '/slow') {
        return new Response(
          new ReadableStream({
            async start(c) {
              for (let i = 0; i < body.length; i += 64 * 1024) {
                c.enqueue(body.subarray(i, i + 64 * 1024))
                await Bun.sleep(5)
              }
              c.close()
            },
          }),
        )
      }
      return new Response('nope', { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => {
  server.stop(true)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('downloadTo', () => {
  test('a complete download lands at the final path, with monotonic progress', async () => {
    const dest = path.join(tmp, 'ok.zip')
    const seen: number[] = []
    await downloadTo(`${base}/ok`, dest, { size: body.length, sha256: sha, onProgress: (r) => seen.push(r) })
    expect(fs.readFileSync(dest)).toEqual(Buffer.from(body))
    expect(seen.at(-1)).toBe(body.length)
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!)).toBe(true)
    expect(fs.existsSync(`${dest}.partial`)).toBe(false)
  })
  test('a short body, a wrong checksum and a 404 leave nothing behind', async () => {
    const dest = path.join(tmp, 'bad.zip')
    await expect(downloadTo(`${base}/short`, dest, { size: body.length, sha256: sha })).rejects.toThrow(/completely|downloaded/)
    await expect(downloadTo(`${base}/ok`, dest, { size: body.length, sha256: '0'.repeat(64) })).rejects.toThrow(/damaged/)
    await expect(downloadTo(`${base}/missing`, dest, { size: 0, sha256: sha })).rejects.toThrow(/404/)
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(`${dest}.partial`)).toBe(false)
  })
  test('no checksum to check against is refused before a byte is fetched', async () => {
    const dest = path.join(tmp, 'unverified.zip')
    let fetched = 0
    const fetchFn = async (url: string) => (fetched++, fetch(url))
    for (const sha256 of ['', 'abc', null as unknown as string]) {
      const err = await downloadTo(`${base}/ok`, dest, { size: body.length, sha256, fetch: fetchFn }).catch((e) => e)
      expect(err.code).toBe('unverified')
    }
    expect(fetched).toBe(0)
    expect(fs.existsSync(dest)).toBe(false)
  })
  test('a checksum-less download is refused without naming the staging file', async () => {
    const err = await downloadTo(`${base}/ok`, path.join(tmp, 'app-update-4242-1.1.0.manifest.json'), { size: 1, sha256: '' }).catch((e) => e)
    expect(err.message).not.toContain('4242')
    expect(err.cause.message).toContain(`${base}/ok`)
  })
  test('a disk that refuses the download is the disk, not the connection', async () => {
    // A file where the download's folder should be: the first write to disk fails.
    const notADir = path.join(tmp, 'not-a-dir')
    fs.writeFileSync(notADir, '')
    const err = await downloadTo(`${base}/ok`, path.join(notADir, 'x.zip'), { size: body.length, sha256: sha }).catch((e) => e)
    expect(err.code).toBe('blocked')
    expect(err.message).toMatch(/saved to disk/)
    expect(err.message).not.toMatch(/connection/)
  })
  test('cancelling mid-stream reports cancelled and removes the partial', async () => {
    const dest = path.join(tmp, 'cancel.zip')
    const ac = new AbortController()
    const p = downloadTo(`${base}/slow`, dest, { size: body.length, sha256: sha, signal: ac.signal, onProgress: (r) => r > 100_000 && ac.abort() })
    const err = await p.catch((e) => e)
    expect(err.code).toBe('cancelled')
    expect(fs.existsSync(`${dest}.partial`)).toBe(false)
  })
})
