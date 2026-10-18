/** The local feed: a build's downloads, answered the way jsonRelease reads them. */
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeLocalFeed } from './feed'
import { jsonRelease } from './source'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-feed-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('writeLocalFeed', () => {
  test('lists every file with its size and hash, and jsonRelease reads it back', async () => {
    const dir = path.join(tmp, 'one')
    fs.mkdirSync(path.join(dir, 'staging'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'App-windows-x64-setup.exe'), 'setup bytes')
    fs.writeFileSync(path.join(dir, 'App-darwin-arm64.dmg'), 'dmg')
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x')
    const feed = await writeLocalFeed({ dir, version: '1.2.3', url: 'https://notes' })
    expect(feed.release.version).toBe('1.2.3')
    expect(feed.release.assets.map((a) => a.name)).toEqual(['App-darwin-arm64.dmg', 'App-windows-x64-setup.exe'])
    expect(feed.release.assets[1]).toMatchObject({ size: 11, sha256: sha('setup bytes') })
    expect(feed.fileUrl).toMatch(/^file:\/\/\/.*release\.json$/)
    const read = await jsonRelease(feed.fileUrl).latest()
    expect(read?.assets).toHaveLength(2)
    expect(read?.url).toBe('https://notes')
    // Written again over its own output, it does not list itself.
    expect((await writeLocalFeed({ dir, version: '1.2.3', url: 'https://notes' })).release.assets).toHaveLength(2)
  })
  test('refuses an empty or missing directory and a version that is not X.Y.Z', async () => {
    fs.mkdirSync(path.join(tmp, 'empty'))
    await expect(writeLocalFeed({ dir: path.join(tmp, 'empty'), version: '1.0.0', url: 'u' })).rejects.toThrow(/nothing to list/)
    await expect(writeLocalFeed({ dir: path.join(tmp, 'missing'), version: '1.0.0', url: 'u' })).rejects.toThrow(/nothing to list/)
    await expect(writeLocalFeed({ dir: tmp, version: '1.0', url: 'u' })).rejects.toThrow(/not a version/)
  })
})
