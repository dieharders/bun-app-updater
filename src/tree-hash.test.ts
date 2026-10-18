/** The content hash: same content hashes the same wherever it sits; any difference shows. */
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hashTree } from './tree-hash'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-hash-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const plant = (name: string, files: Record<string, string>): string => {
  const root = path.join(tmp, name)
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return root
}

describe('hashTree', () => {
  test('two trees with the same files hash the same, whatever their names, times or empty dirs', async () => {
    const a = plant('a', { 'ffmpeg': 'bin', 'chrome/shell': 'x', 'chrome/notes.txt': 'y' })
    const b = plant('b', { 'chrome/notes.txt': 'y', 'ffmpeg': 'bin', 'chrome/shell': 'x' })
    fs.mkdirSync(path.join(b, 'empty'))
    fs.utimesSync(path.join(b, 'ffmpeg'), 1, 1)
    expect(await hashTree(a)).toBe((await hashTree(b))!)
  })
  test('a changed byte, a renamed file, an added file, a missing file each change it', async () => {
    const base = await hashTree(plant('base', { 'f': '1', 'd/g': '2' }))
    expect(await hashTree(plant('byte', { 'f': '1', 'd/g': '3' }))).not.toBe(base)
    expect(await hashTree(plant('renamed', { 'f': '1', 'd/h': '2' }))).not.toBe(base)
    expect(await hashTree(plant('added', { 'f': '1', 'd/g': '2', 'extra': '' }))).not.toBe(base)
    expect(await hashTree(plant('missing', { 'f': '1' }))).not.toBe(base)
  })
  test('a single file hashes too, and something absent is null', async () => {
    const one = plant('one', { 'app.exe': 'exe' })
    const h = await hashTree(path.join(one, 'app.exe'))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashTree(path.join(one, 'app.exe'), { yieldEveryBytes: 1 })).toBe(h!)
    expect(await hashTree(path.join(tmp, 'nope'))).toBeNull()
  })
  test.skipIf(process.platform === 'win32')('a symlink hashes by its target, not by what it points at', async () => {
    const root = plant('links', { 'lib/data': 'd' })
    fs.symlinkSync('../lib/data', path.join(root, 'bin-link'))
    const h = await hashTree(root)
    fs.writeFileSync(path.join(root, 'lib/data'), 'changed')
    expect(await hashTree(root)).not.toBe(h)
    const other = plant('links2', { 'lib/data': 'changed' })
    fs.symlinkSync('../lib/data', path.join(other, 'bin-link'))
    expect(await hashTree(other)).toBe((await hashTree(root))!)
  })
})
