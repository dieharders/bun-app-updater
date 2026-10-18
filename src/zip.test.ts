/** Streamed extraction, modes and symlinks restored from the central directory, unsafe names refused. */
import { afterAll, describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyZipModes, readZipEntries, safeEntryPath, unzipToDir } from './zip'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-zip-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const enc = (s: string) => new TextEncoder().encode(s)
const unix = (mode: number) => ({ os: 3, attrs: mode << 16 })
const write = (name: string, zip: Uint8Array) => {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, zip)
  return p
}

describe('unzipToDir', () => {
  test('a multi-megabyte entry read in small chunks comes out whole, with progress and top-level names', async () => {
    const big = new Uint8Array(5 * 1024 * 1024).map((_, i) => (i * 7) % 256)
    const zip = write('big.zip', zipSync({ 'app.exe': enc('exe'), 'vendor/ffmpeg': [big, unix(0o100755)], 'vendor/notes.txt': enc('hi'), 'unins000.dat': enc('x') }))
    const out = path.join(tmp, 'big-out')
    const seen: number[] = []
    const result = await unzipToDir(zip, out, { onProgress: (d) => seen.push(d), yieldEveryBytes: 1024 })
    expect(fs.readFileSync(path.join(out, 'vendor', 'ffmpeg'))).toEqual(Buffer.from(big))
    expect(fs.readFileSync(path.join(out, 'app.exe'), 'utf8')).toBe('exe')
    expect(result.topLevel.sort()).toEqual(['app.exe', 'unins000.dat', 'vendor'])
    expect(result.entries).toBe(4)
    expect(seen.at(-1)).toBe(fs.statSync(zip).size)
  })

  test('refuses an unsafe name before writing anything', async () => {
    const out = path.join(tmp, 'unsafe-out')
    for (const name of ['../escape.txt', '/abs.txt', 'C:/win.txt', 'a/../../b.txt']) {
      const zip = write('unsafe.zip', zipSync({ [name]: enc('x') }))
      await expect(unzipToDir(zip, out)).rejects.toThrow(/unsafe path/)
    }
    expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(false)
    expect(() => safeEntryPath('/x', 'ok/fine.txt')).not.toThrow()
  })

  test('something that is not a zip', async () => {
    const zip = write('not.zip', enc('definitely not a zip file'))
    await expect(unzipToDir(zip, path.join(tmp, 'not-out'))).rejects.toThrow()
    expect(() => readZipEntries(zip)).toThrow(/isn't a zip/)
  })
})

describe('readZipEntries + applyZipModes', () => {
  test('modes come from the central directory; exec bits and symlinks are restored', async () => {
    const zip = write(
      'modes.zip',
      zipSync({
        'app/bin/tool': [enc('#!/bin/sh\n'), unix(0o100755)],
        'app/lib/data.txt': [enc('data'), unix(0o100644)],
        'app/bin/link': [enc('../lib/data.txt'), unix(0o120777)],
        'app/dos.txt': enc('dos'),
      }),
    )
    const entries = readZipEntries(zip)
    expect(entries.map((e) => [e.name, e.mode, e.isSymlink])).toEqual([
      ['app/bin/tool', 0o100755, false],
      ['app/lib/data.txt', 0o100644, false],
      ['app/bin/link', 0o120777, true],
      ['app/dos.txt', null, false],
    ])
    const out = path.join(tmp, 'modes-out')
    await unzipToDir(zip, out)
    // The rest is POSIX: Windows has no exec bit, and symlinks there need a privilege.
    if (process.platform === 'win32') return
    applyZipModes(zip, out, 'linux')
    expect(fs.statSync(path.join(out, 'app/bin/tool')).mode & 0o111).toBeTruthy()
    expect(fs.statSync(path.join(out, 'app/lib/data.txt')).mode & 0o111).toBeFalsy()
    expect(fs.lstatSync(path.join(out, 'app/bin/link')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(out, 'app/bin/link'), 'utf8')).toBe('data')
  })

  test.skipIf(process.platform === 'win32')('a symlink pointing outside the tree is refused', async () => {
    const zip = write('badlink.zip', zipSync({ 'app/evil': [enc('../../../../etc/passwd'), unix(0o120777)] }))
    const out = path.join(tmp, 'badlink-out')
    await unzipToDir(zip, out)
    expect(() => applyZipModes(zip, out, 'linux')).toThrow(/outside/)
  })

  test('on Windows nothing is applied', async () => {
    const zip = write('win.zip', zipSync({ 'app/bin/tool': [enc('x'), unix(0o100755)] }))
    const out = path.join(tmp, 'win-out')
    await unzipToDir(zip, out)
    expect(() => applyZipModes(zip, out, 'win32')).not.toThrow()
  })
})
