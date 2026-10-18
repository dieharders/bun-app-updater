/** The manifest reader: a good one comes through normalised; every way of being wrong is named. */
import { describe, expect, test } from 'bun:test'
import { MANIFEST_FORMAT, parseManifest } from './manifest'

const sha = 'A'.repeat(64)
const good = () => ({
  format: MANIFEST_FORMAT,
  version: '1.2.3',
  target: 'windows-x64',
  parts: [
    { name: 'app.exe', asset: 'App-1.2.3-windows-x64-app.zip', size: 10, sha256: sha, tree: sha },
    { name: 'vendor', asset: 'App-1.2.3-windows-x64-vendor.zip', size: 20, sha256: sha, tree: sha },
  ],
})
const expect_ = { version: '1.2.3', target: 'windows-x64' }

describe('parseManifest', () => {
  test('a good manifest, hashes lowercased', () => {
    const m = parseManifest(good(), expect_)
    expect(m.parts.map((p) => p.name)).toEqual(['app.exe', 'vendor'])
    expect(m.parts[0]!.sha256).toBe('a'.repeat(64))
    expect(m.parts[0]!.tree).toBe('a'.repeat(64))
  })
  test('the wrong version, target or format is refused, so a mislabelled asset never installs', () => {
    expect(() => parseManifest(good(), { ...expect_, version: '1.2.4' })).toThrow(/is for 1.2.3, not 1.2.4/)
    expect(() => parseManifest(good(), { ...expect_, target: 'linux-x64' })).toThrow(/not linux-x64/)
    expect(() => parseManifest({ ...good(), format: 2 }, expect_)).toThrow(/format 2/)
    expect(() => parseManifest('nope', expect_)).toThrow(/not an object/)
  })
  test('a part with no checksum, no content hash, no size, an unsafe name or a duplicate', () => {
    const edit = (f: (p: Record<string, unknown>) => void) => {
      const m = good()
      f(m.parts[1] as unknown as Record<string, unknown>)
      return m
    }
    expect(() => parseManifest(edit((p) => delete p.sha256), expect_)).toThrow(/no checksum for vendor/)
    expect(() => parseManifest(edit((p) => (p.tree = 'xyz')), expect_)).toThrow(/no content hash for vendor/)
    expect(() => parseManifest(edit((p) => (p.size = 0)), expect_)).toThrow(/no size for vendor/)
    expect(() => parseManifest(edit((p) => (p.name = '../vendor')), expect_)).toThrow(/unsafe name/)
    expect(() => parseManifest(edit((p) => (p.name = 'app.exe')), expect_)).toThrow(/twice/)
    expect(() => parseManifest({ ...good(), parts: [] }, expect_)).toThrow(/no parts/)
  })
})
