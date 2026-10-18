/**
 * Zip archives, read two ways.
 *
 * `unzipToDir` STREAMS the archive through fflate's `Unzip`, writing each file as its bytes
 * arrive. A full build zip is a quarter of a gigabyte holding over half a gigabyte, and the
 * one-call `unzipSync` would hold all of that in memory at once.
 *
 * fflate's streaming reader exposes a file's name and bytes and nothing else — in particular
 * not the POSIX mode in the central directory, which is where `zip` and `ditto` record which
 * files are executables and which entries are symlinks. `readZipEntries` reads that central
 * directory itself (it is a short, well-specified structure at the end of the file), and
 * `applyZipModes` puts the modes and symlinks back after extraction. Without that a Linux
 * build would unpack with no executable bit on any of its binaries.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'
import { UpdateError } from './errors'

export interface ZipEntry {
  /** Forward-slash path, as stored. Directories end in `/`. */
  name: string
  /** The POSIX mode (type bits included) when the archive recorded one, else null. */
  mode: number | null
  isDir: boolean
  isSymlink: boolean
}

export interface UnzipOptions {
  signal?: AbortSignal
  /** Bytes of the archive consumed so far, against its size. */
  onProgress?: (done: number, total: number) => void
  /** Yield to the event loop after this many archive bytes, so a server stays responsive. */
  yieldEveryBytes?: number
  /** Refuse an archive whose files would unpack to more than this. */
  maxUnpackedBytes?: number
}

export interface UnzipResult {
  entries: number
  bytes: number
  /** The distinct first path segments: what the archive puts at the top of `dest`. */
  topLevel: string[]
}

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFDIR = 0o040000

/**
 * The path inside `dest` an entry may be written to, or a refusal. Archives come from the
 * network: a name with `..`, an absolute path or a drive letter must never be written anywhere.
 */
export function safeEntryPath(dest: string, name: string): string {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new UpdateError('unpack_failed', `The update's download has an entry with an unsafe path (${name}).`)
  }
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some((p) => p === '..' || p === '.')) {
    throw new UpdateError('unpack_failed', `The update's download has an entry with an unsafe path (${name}).`)
  }
  return path.join(dest, ...parts)
}

export async function unzipToDir(zipPath: string, dest: string, opts: UnzipOptions = {}): Promise<UnzipResult> {
  const total = fs.statSync(zipPath).size
  const chunkSize = 4 * 1024 * 1024
  const yieldEvery = opts.yieldEveryBytes ?? 16 * 1024 * 1024
  const maxUnpacked = opts.maxUnpackedBytes ?? 8 * 1024 * 1024 * 1024
  fs.mkdirSync(dest, { recursive: true })

  let entries = 0
  let unpacked = 0
  const topLevel = new Set<string>()
  let failure: unknown = null
  const openFds = new Map<string, number>()

  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  unzip.onfile = (file) => {
    if (failure) return
    try {
      const target = safeEntryPath(dest, file.name)
      topLevel.add(file.name.replace(/\\/g, '/').split('/').filter(Boolean)[0]!)
      entries++
      if (file.name.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true })
        return
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const fd = fs.openSync(target, 'w')
      openFds.set(target, fd)
      file.ondata = (err, chunk, final) => {
        if (failure) return
        if (err) {
          failure = err
          return
        }
        try {
          if (chunk.length) {
            fs.writeSync(fd, chunk)
            unpacked += chunk.length
            if (unpacked > maxUnpacked) {
              failure = new UpdateError('unpack_failed', "The update's download unpacks to more than this updater allows.")
            }
          }
          if (final) {
            fs.closeSync(fd)
            openFds.delete(target)
          }
        } catch (e) {
          failure = e
        }
      }
      file.start()
    } catch (e) {
      failure = e
    }
  }

  const fd = fs.openSync(zipPath, 'r')
  try {
    // fflate skips bytes it does not recognise rather than failing, so a download that is not
    // a zip at all would "unpack" to nothing. A zip's first record is a local file header.
    const head = Buffer.alloc(4)
    fs.readSync(fd, head, 0, 4, 0)
    if (total < 22 || head.readUInt32LE(0) !== 0x04034b50) {
      throw new UpdateError('unpack_failed', "The update's download isn't a zip archive.")
    }
    const buf = new Uint8Array(chunkSize)
    let done = 0
    let sinceYield = 0
    while (done < total) {
      if (opts.signal?.aborted) throw new UpdateError('cancelled', 'The update was cancelled.')
      const n = fs.readSync(fd, buf, 0, chunkSize, done)
      if (n <= 0) break
      done += n
      // fflate keeps a reference to what it is handed; a fresh copy per push is the cost of
      // reusing one read buffer.
      unzip.push(buf.slice(0, n), done >= total)
      if (failure) throw failure
      opts.onProgress?.(done, total)
      sinceYield += n
      if (sinceYield >= yieldEvery) {
        sinceYield = 0
        await Bun.sleep(0)
      }
    }
    if (done < total) unzip.push(new Uint8Array(0), true)
    if (failure) throw failure
  } catch (err) {
    for (const open of openFds.values()) {
      try {
        fs.closeSync(open)
      } catch {
        // Already closed.
      }
    }
    if (err instanceof UpdateError) throw err
    throw new UpdateError('unpack_failed', "The update's download couldn't be unpacked.", { cause: err })
  } finally {
    fs.closeSync(fd)
  }
  if (openFds.size) {
    for (const open of openFds.values()) fs.closeSync(open)
    throw new UpdateError('unpack_failed', "The update's download ended before all of its files did.")
  }
  return { entries, bytes: unpacked, topLevel: [...topLevel] }
}

/**
 * The central directory: every entry's name and recorded mode.
 *
 * Reads the end-of-central-directory record (and its zip64 form when the archive uses it),
 * then walks the entries. The mode is the high 16 bits of the external attributes, which only
 * mean a POSIX mode when the archive was made on Unix (host OS 3) or macOS (19) — a Windows
 * zip's external attributes are DOS flags, reported here as null.
 */
export function readZipEntries(zipPath: string): ZipEntry[] {
  const size = fs.statSync(zipPath).size
  const fd = fs.openSync(zipPath, 'r')
  try {
    const readAt = (offset: number, length: number): Buffer => {
      const buf = Buffer.alloc(length)
      const n = fs.readSync(fd, buf, 0, length, offset)
      return n === length ? buf : buf.subarray(0, n)
    }

    // The EOCD is the last 22 bytes plus up to 65535 bytes of comment.
    const tailLen = Math.min(size, 22 + 65535)
    const tail = readAt(size - tailLen, tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new UpdateError('unpack_failed', "The update's download isn't a zip archive.")

    let count = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // zip64: a locator sits just before the EOCD and points at the zip64 EOCD record.
      const locAt = eocd - 20
      if (locAt < 0 || tail.readUInt32LE(locAt) !== 0x07064b50) {
        throw new UpdateError('unpack_failed', "The update's download is a zip64 archive without a locator.")
      }
      const z64At = Number(tail.readBigUInt64LE(locAt + 8))
      const z64 = readAt(z64At, 56)
      if (z64.readUInt32LE(0) !== 0x06064b50) {
        throw new UpdateError('unpack_failed', "The update's download has a damaged zip64 record.")
      }
      count = Number(z64.readBigUInt64LE(32))
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
    }

    const cd = readAt(cdOffset, cdSize)
    const entries: ZipEntry[] = []
    let at = 0
    for (let i = 0; i < count && at + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(at) !== 0x02014b50) {
        throw new UpdateError('unpack_failed', "The update's download has a damaged central directory.")
      }
      const hostOs = cd.readUInt8(at + 5)
      const nameLen = cd.readUInt16LE(at + 28)
      const extraLen = cd.readUInt16LE(at + 30)
      const commentLen = cd.readUInt16LE(at + 32)
      const external = cd.readUInt32LE(at + 38)
      const name = cd.toString('utf8', at + 46, at + 46 + nameLen)
      const high = external >>> 16
      const unix = hostOs === 3 || hostOs === 19 || (high & S_IFMT) !== 0
      const mode = unix && high !== 0 ? high : null
      const isDir = name.endsWith('/') || (mode !== null && (mode & S_IFMT) === S_IFDIR)
      const isSymlink = mode !== null && (mode & S_IFMT) === S_IFLNK
      entries.push({ name, mode, isDir, isSymlink })
      at += 46 + nameLen + extraLen + commentLen
    }
    return entries
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Restore what the streaming extraction could not: executable bits, and symlinks (which the
 * extraction wrote as small files holding the link target). POSIX only; Windows has neither.
 */
export function applyZipModes(zipPath: string, dest: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return
  const root = path.resolve(dest)
  for (const entry of readZipEntries(zipPath)) {
    if (entry.mode === null || entry.isDir) continue
    const file = safeEntryPath(root, entry.name)
    if (entry.isSymlink) {
      let linkTarget: string
      try {
        linkTarget = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      // A link must stay inside the unpacked tree: `../Resources/vendor` from `Contents/MacOS`
      // is fine, `../../../etc/passwd` is not.
      const resolved = path.resolve(path.dirname(file), linkTarget)
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new UpdateError('unpack_failed', `The update's download has a symlink pointing outside it (${entry.name}).`)
      }
      fs.rmSync(file, { force: true })
      fs.symlinkSync(linkTarget, file)
      continue
    }
    if (entry.mode & 0o111) {
      try {
        fs.chmodSync(file, entry.mode & 0o7777)
      } catch {
        // A file the archive listed but did not carry; nothing to mark.
      }
    }
  }
}
