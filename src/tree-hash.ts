/**
 * One hash for a file or a whole directory tree, so an installed `vendor/` can be compared with
 * the `vendor/` a release carries without downloading it.
 *
 * The build computes this for every top-level entry it ships and writes it into the release's
 * manifest; the updater computes it for the installed entries and downloads only those whose
 * hash differs. The archive bytes could not serve: a zip of identical files differs from build
 * to build (timestamps, tool versions), so the hash has to be over the CONTENT — every file's
 * relative path and SHA-256, every symlink's target, nothing else. Modes and times are left
 * out on purpose: a build machine's umask or a copy's mtime must not make `vendor/` look stale.
 *
 * Reads in chunks and yields to the event loop now and then, because the installed tree is
 * most of a gigabyte and this runs inside a server that is still answering its page.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface TreeHashOptions {
  /** Yield to the event loop after this many bytes read. */
  yieldEveryBytes?: number
  signal?: AbortSignal
}

const CHUNK = 4 * 1024 * 1024

/**
 * The hash of `root`: a file, a symlink or a directory. Null when it does not exist, which is
 * what a part the install has never had looks like.
 */
export async function hashTree(root: string, opts: TreeHashOptions = {}): Promise<string | null> {
  const yieldEvery = opts.yieldEveryBytes ?? 16 * 1024 * 1024
  let sinceYield = 0
  const buf = Buffer.alloc(CHUNK)

  const fileSha = async (file: string): Promise<string> => {
    const h = createHash('sha256')
    const fd = fs.openSync(file, 'r')
    try {
      for (;;) {
        if (opts.signal?.aborted) throw new Error('aborted')
        const n = fs.readSync(fd, buf, 0, CHUNK, null)
        if (n <= 0) break
        h.update(buf.subarray(0, n))
        sinceYield += n
        if (sinceYield >= yieldEvery) {
          sinceYield = 0
          await Bun.sleep(0)
        }
      }
    } finally {
      fs.closeSync(fd)
    }
    return h.digest('hex')
  }

  const lines: string[] = []
  const walk = async (p: string, rel: string): Promise<void> => {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) {
      lines.push(`${rel}\0l\0${createHash('sha256').update(fs.readlinkSync(p).replace(/\\/g, '/')).digest('hex')}`)
      return
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) await walk(path.join(p, name), rel ? `${rel}/${name}` : name)
      return
    }
    if (st.isFile()) lines.push(`${rel}\0f\0${await fileSha(p)}`)
    // Anything else (a socket, a device) is not something a build ships; ignored.
  }

  if (!fs.existsSync(root) && !isDanglingLink(root)) return null
  await walk(root, '')
  // Sorted here rather than by directory order, which differs between filesystems.
  lines.sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

const isDanglingLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
