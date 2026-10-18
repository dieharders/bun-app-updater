/**
 * A release feed for update parts on this machine, so an update can be rehearsed end to end
 * with nothing published.
 *
 * Reads a directory holding what `writeUpdateParts` wrote (the manifest and one zip per part)
 * and writes `release.json` beside them, in the shape `jsonRelease` (source.ts) reads: every
 * file as an asset with a `file:` URL, its size and its SHA-256 — exactly the facts a GitHub
 * release would list, so the installed copy exercises the same checks. Point the app at it with
 * whatever environment variable its config honours for a local feed.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseManifest } from './manifest'
import type { Release } from './source'

export interface WriteFeedOptions {
  /** The directory holding the manifest(s) and parts. */
  dir: string
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
  const fileName = opts.fileName ?? 'release.json'
  const files = fs.existsSync(opts.dir) ? fs.readdirSync(opts.dir).filter((f) => f !== fileName).sort() : []
  const manifests = files.filter((f) => f.endsWith('.manifest.json'))
  if (manifests.length === 0) throw new Error(`no *.manifest.json in ${opts.dir}; write the update parts first`)

  // Every manifest here must be for the same version: one feed answers with one release.
  const versions = new Set<string>()
  for (const m of manifests) {
    const raw = JSON.parse(fs.readFileSync(path.join(opts.dir, m), 'utf8')) as { version?: unknown; target?: unknown }
    const parsed = parseManifest(raw, { version: String(raw.version), target: String(raw.target) })
    versions.add(parsed.version)
    for (const part of parsed.parts) {
      if (!files.includes(part.asset)) throw new Error(`${m} lists ${part.asset}, which is not in ${opts.dir}`)
    }
  }
  if (versions.size !== 1) throw new Error(`${opts.dir} holds manifests for ${[...versions].join(' and ')}; a feed answers with one version`)

  const assets = []
  for (const name of files) {
    const file = path.join(opts.dir, name)
    assets.push({ name, url: Bun.pathToFileURL(file).href, size: fs.statSync(file).size, sha256: await sha256Of(file) })
  }
  const release: Release = { version: [...versions][0]!, url: opts.url, assets }
  const out = path.join(opts.dir, fileName)
  fs.writeFileSync(out, `${JSON.stringify(release, null, 2)}\n`)
  return { path: out, fileUrl: Bun.pathToFileURL(out).href, release }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject))
  return hash.digest('hex')
}
