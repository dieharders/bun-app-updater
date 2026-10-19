/**
 * A release feed for builds on this machine, so an update can be rehearsed end to end with
 * nothing published.
 *
 * Lists every file in a directory (the installers a build wrote) and writes `release.json`
 * beside them, in the shape `jsonRelease` (source.ts) reads: each file as an asset with a
 * `file:` URL, its size and its SHA-256 — exactly the facts a GitHub release would list, so the
 * installed copy exercises the same checks. Point the app at it with whatever environment
 * variable its config honours for a local feed.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Release } from './source'
import { parseVersion } from './version'

export interface WriteFeedOptions {
  /** The directory holding the release's downloads. */
  dir: string
  /** The version the feed announces: the build's, which must be newer than the copy to update. */
  version: string
  /** The release page the app may open ("What's new"). */
  url: string
  /** The feed's file name in `dir`. Default `release.json`. */
  fileName?: string
}

export interface WrittenFeed {
  path: string
  /** The `file:` URL of the feed, ready for the app's environment. */
  fileUrl: string
  release: Release
}

export async function writeLocalFeed(opts: WriteFeedOptions): Promise<WrittenFeed> {
  if (!parseVersion(opts.version)) throw new Error(`${opts.version} is not a version (X.Y.Z)`)
  const fileName = opts.fileName ?? 'release.json'
  const files = fs.existsSync(opts.dir)
    ? fs
        .readdirSync(opts.dir)
        .filter((f) => f !== fileName && !f.startsWith('.') && fs.statSync(path.join(opts.dir, f)).isFile())
        .sort()
    : []
  if (files.length === 0) throw new Error(`nothing to list in ${opts.dir}; build the release's downloads first`)

  const assets = []
  for (const name of files) {
    const file = path.join(opts.dir, name)
    assets.push({ name, url: Bun.pathToFileURL(file).href, size: fs.statSync(file).size, sha256: await sha256Of(file) })
  }
  const release: Release = { version: opts.version, url: opts.url, assets }
  const out = path.join(opts.dir, fileName)
  fs.writeFileSync(out, `${JSON.stringify(release, null, 2)}\n`)
  return { path: out, fileUrl: Bun.pathToFileURL(out).href, release }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject))
  return hash.digest('hex')
}
