/** The build side on this platform's archiver: parts written, read back, and the manifest the updater wants. */
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseManifest } from './manifest'
import { writeUpdateParts } from './parts'
import { hashTree } from './tree-hash'
import { unzipToDir } from './zip'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-parts-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const platform = process.platform
const exe = platform === 'win32' ? 'app.exe' : 'app'

const stage = (): string => {
  const dir = path.join(tmp, 'stage')
  fs.mkdirSync(path.join(dir, 'vendor', 'chrome'), { recursive: true })
  fs.writeFileSync(path.join(dir, exe), 'the executable')
  fs.writeFileSync(path.join(dir, 'vendor', 'ffmpeg'), 'ffmpeg bytes', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'vendor', 'chrome', 'shell'), 'x'.repeat(100_000))
  fs.writeFileSync(path.join(dir, 'app.desktop'), 'launcher')
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk')
  return dir
}

describe.skipIf(platform === 'darwin')('writeUpdateParts', () => {
  test('one zip per entry, skips honoured, manifest parseable, hashes round-trip', async () => {
    const dir = stage()
    const out = path.join(tmp, 'out')
    fs.mkdirSync(out)
    fs.writeFileSync(path.join(out, 'App-0.9.0-stale.zip'), 'from the previous version')
    const lines: string[] = []
    const written = await writeUpdateParts({
      sourceDir: dir,
      outDir: out,
      version: '1.0.0',
      target: 'test-x64',
      platform,
      manifestName: 'App-1.0.0-test-x64.manifest.json',
      partName: (entry) => `App-1.0.0-test-x64-${entry.replace(/\.exe$/, '')}.zip`,
      skip: ['app.desktop'],
      required: [exe, 'vendor'],
      executables: ['vendor/ffmpeg'],
      log: (l) => lines.push(l),
    })
    expect(fs.readdirSync(out).sort()).toEqual(['App-1.0.0-test-x64-app.zip', 'App-1.0.0-test-x64-vendor.zip', 'App-1.0.0-test-x64.manifest.json'])
    const manifest = parseManifest(JSON.parse(fs.readFileSync(written.manifestPath, 'utf8')), { version: '1.0.0', target: 'test-x64' })
    expect(manifest.parts.map((p) => p.name)).toEqual([exe, 'vendor'])
    expect(manifest.parts[1]!.tree).toBe((await hashTree(path.join(dir, 'vendor')))!)
    expect(written.files).toHaveLength(3)
    expect(lines.at(-1)).toMatch(/2 parts/)
    // What an install would unpack hashes to what the manifest says.
    const unpacked = path.join(tmp, 'unpacked')
    await unzipToDir(path.join(out, 'App-1.0.0-test-x64-vendor.zip'), unpacked)
    expect(await hashTree(path.join(unpacked, 'vendor'))).toBe(manifest.parts[1]!.tree)
  })
  test('a tree missing a required entry is refused before anything is written', async () => {
    const dir = stage()
    const out = path.join(tmp, 'out2')
    await expect(
      writeUpdateParts({ sourceDir: dir, outDir: out, version: '1.0.0', target: 't', platform, manifestName: 'm.json', partName: (e) => `${e}.zip`, required: ['library'] }),
    ).rejects.toThrow(/missing library/)
    expect(fs.readdirSync(out)).toEqual([])
  })
})

// Info-ZIP runs in `sourceDir`; it is on macOS too, so the Linux path is tested there as well.
describe.skipIf(platform === 'win32' || !Bun.which('zip'))('writeUpdateParts, Linux', () => {
  test('a relative outDir is read from where the build runs, not from sourceDir', async () => {
    const dir = stage()
    const out = path.relative(process.cwd(), path.join(tmp, 'rel-out'))
    expect(path.isAbsolute(out)).toBe(false)
    const written = await writeUpdateParts({
      sourceDir: path.relative(process.cwd(), dir),
      outDir: out,
      version: '1.0.0',
      target: 'linux-x64',
      platform: 'linux',
      manifestName: 'm.json',
      partName: (entry) => `${entry}.zip`,
      skip: ['app.desktop'],
      executables: ['vendor/ffmpeg'],
    })
    expect(fs.readdirSync(path.join(tmp, 'rel-out')).sort()).toEqual(['app.zip', 'm.json', 'vendor.zip'])
    expect(written.files.every((f) => path.isAbsolute(f))).toBe(true)
  })
})
