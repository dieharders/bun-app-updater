/**
 * Fetch one release download to disk and prove it is the one the feed listed.
 *
 * Streamed to a `.partial` file and hashed as it goes: these downloads are hundreds of
 * megabytes, so neither buffering the body in memory nor a second pass over the disk to hash it
 * is acceptable. Nothing is renamed to its final name until the size and the SHA-256 match, so
 * a download that dies half way leaves no file that looks finished.
 *
 * THE HASH IS NOT OPTIONAL. An earlier version skipped the check when the feed listed no
 * digest, which installed such a download with no integrity check at all and nothing in the log
 * to say so. The feed is under the publisher's control, so a missing digest is a publishing
 * mistake to surface (`unverified`), never a reason to trust the bytes.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { UpdateError, isAbort } from './errors'
import type { Fetch } from './source'

export interface DownloadOptions {
  /** Expected byte count; 0 when the feed does not say. */
  size: number
  /** Hex SHA-256 the download must hash to. Required: see the note at the top. */
  sha256: string
  signal?: AbortSignal
  onProgress?: (received: number, total: number) => void
  /** Called once the bytes are all on disk and the checks are about to run. */
  onVerifying?: () => void
  fetch?: Fetch
  /** Whole-download ceiling; a 250 MB download on a slow link needs more than a request timeout. */
  timeoutMs?: number
}

export async function downloadTo(url: string, dest: string, opts: DownloadOptions): Promise<void> {
  const fetchFn = opts.fetch ?? fetch
  if (!/^[0-9a-f]{64}$/i.test(opts.sha256 ?? '')) {
    throw new UpdateError('unverified', `The release feed lists no checksum for ${path.basename(dest)}, so it can't be verified. Download the update instead.`)
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  const offline = 'The update could not be downloaded. Check your connection and try again.'

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60 * 60_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

  let fd: number | null = null
  try {
    let res: Response
    try {
      res = await fetchFn(url, { signal })
    } catch (err) {
      if (opts.signal?.aborted) throw new UpdateError('cancelled', 'The update was cancelled.', { cause: err })
      throw new UpdateError('offline', offline, { cause: err })
    }
    if (!res.ok || !res.body) {
      throw new UpdateError('offline', `The update could not be downloaded (${res.status}). Try again.`)
    }

    const total = Number(res.headers.get('content-length')) || opts.size
    const hasher = createHash('sha256')
    fd = fs.openSync(partial, 'w')
    let received = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hasher.update(chunk)
        fs.writeSync(fd, chunk)
        received += chunk.byteLength
        opts.onProgress?.(received, total)
      }
    } catch (err) {
      if (opts.signal?.aborted || isAbort(err)) {
        throw new UpdateError(opts.signal?.aborted ? 'cancelled' : 'offline', opts.signal?.aborted ? 'The update was cancelled.' : offline, { cause: err })
      }
      throw new UpdateError('offline', offline, { cause: err })
    }
    fs.closeSync(fd)
    fd = null

    opts.onVerifying?.()
    if (opts.size > 0 && received !== opts.size) {
      throw new UpdateError('damaged', "The update didn't download completely. Try again.")
    }
    const actual = hasher.digest('hex')
    if (actual !== opts.sha256.toLowerCase()) {
      throw new UpdateError('damaged', "The update's download is damaged (its checksum doesn't match). Try again.")
    }
    fs.rmSync(dest, { force: true })
    fs.renameSync(partial, dest)
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Already closed.
      }
    }
    fs.rmSync(partial, { force: true })
  }
}
