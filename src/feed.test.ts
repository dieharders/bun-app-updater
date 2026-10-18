/** The local feed: what writeUpdateParts wrote, answered the way jsonRelease reads it. */
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeLocalFeed } from './feed'
import { MANIFEST_FORMAT } from './manifest'
import { jsonRelease } from './source'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-feed-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const parts = (dir: string, version: string, target: string) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `App-${version}-${target}-app.zip`), 'zip bytes')
  fs.writeFileSync(
    path.join(dir, `App-${version}-${target}.manifest.json`),
    JSON.stringify({ format: MANIFEST_FORMAT, version, target, parts: [{ name: 'app', asset: `App-${version}-${target}-app.zip`, size: 9, sha256: sha('zip bytes'), tree: sha('x') }] }),
  )
}

describe('writeLocalFeed', () => {
  test('lists every file with its size and hash, and jsonRelease reads it back', async () => {
    const dir = path.join(tmp, 'one')
    parts(dir, '1.2.3', 'linux-x64')
    parts(dir, '1.2.3', 'windows-x64')
    const feed = await writeLocalFeed({ dir, url: 'https://notes' })
    expect(feed.release.version).toBe('1.2.3')
    expect(feed.release.assets.map((a) => a.name)).toEqual(['App-1.2.3-linux-x64-app.zip', 'App-1.2.3-linux-x64.manifest.json', 'App-1.2.3-windows-x64-app.zip', 'App-1.2.3-windows-x64.manifest.json'])
    expect(feed.release.assets[0]).toMatchObject({ size: 9, sha256: sha('zip bytes') })
    expect(feed.fileUrl).toMatch(/^file:\/\/\/.*release\.json$/)
    const read = await jsonRelease(feed.fileUrl).latest()
    expect(read?.assets).toHaveLength(4)
    expect(read?.url).toBe('https://notes')
  })
  test('refuses an empty directory, a missing part, and two versions', async () => {
    await expect(writeLocalFeed({ dir: path.join(tmp, 'empty'), url: 'u' })).rejects.toThrow(/no \*\.manifest\.json/)
    const two = path.join(tmp, 'two')
    parts(two, '1.0.0', 't')
    parts(two, '1.1.0', 't')
    await expect(writeLocalFeed({ dir: two, url: 'u' })).rejects.toThrow(/1.0.0 and 1.1.0/)
    const missing = path.join(tmp, 'missing')
    parts(missing, '1.0.0', 't')
    fs.rmSync(path.join(missing, 'App-1.0.0-t-app.zip'))
    await expect(writeLocalFeed({ dir: missing, url: 'u' })).rejects.toThrow(/not in/)
  })
})
