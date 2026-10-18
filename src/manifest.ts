/**
 * What a release says about its update, in parts.
 *
 * A release used to carry one zip of the whole install tree, and every update downloaded all
 * of it — most of it `vendor/` (ffmpeg, a browser, a runtime), which almost never changes. Now
 * a release carries ONE ZIP PER TOP-LEVEL ENTRY of the install tree and this manifest beside
 * them, naming each part, its zip, the zip's size and SHA-256, and the hash of the part's
 * content (tree-hash.ts). The updater hashes what is installed and downloads only the parts
 * whose content differs. The swap already worked an entry at a time, so a partial download is
 * swapped exactly as a whole one was, and nothing is ever left half-replaced: an entry is
 * either the release's or the one that was there.
 *
 * The manifest is itself a release asset, verified by the digest the feed lists for it — so the
 * feed vouches for the manifest and the manifest vouches for the parts.
 */
import { UpdateError } from './errors'
import { parseVersion } from './version'

export const MANIFEST_FORMAT = 1

export interface UpdatePart {
  /** The top-level entry this replaces: `motionbuff.exe`, `vendor`, `MotionBuff.app`. */
  name: string
  /** The release asset holding this part, with the entry at the top of the archive. */
  asset: string
  /** The asset's byte count. */
  size: number
  /** The asset's lowercase hex SHA-256. */
  sha256: string
  /** The entry's content hash (`hashTree`), for comparing with what is installed. */
  tree: string
}

export interface UpdateManifest {
  format: number
  version: string
  target: string
  parts: UpdatePart[]
}

const HEX64 = /^[0-9a-f]{64}$/

/** The manifest, checked against the release it came with; throws `damaged` when it is not one. */
export function parseManifest(raw: unknown, expect: { version: string; target: string }): UpdateManifest {
  const bad = (why: string): never => {
    throw new UpdateError('damaged', `The release's update manifest ${why}.`)
  }
  const m = (raw && typeof raw === 'object' ? raw : bad('is not an object')) as Partial<UpdateManifest>
  if (m.format !== MANIFEST_FORMAT) bad(`is format ${String(m.format)}; this updater reads format ${MANIFEST_FORMAT}`)
  const version = typeof m.version === 'string' ? m.version : ''
  if (!parseVersion(version)) bad('has no version')
  if (version !== expect.version) bad(`is for ${version}, not ${expect.version}`)
  const target = typeof m.target === 'string' ? m.target : ''
  if (target !== expect.target) bad(`is for ${target || 'no target'}, not ${expect.target}`)
  const list: unknown[] = Array.isArray(m.parts) ? m.parts : []
  if (list.length === 0) bad('lists no parts')
  const seen = new Set<string>()
  const parts = list.map((p): UpdatePart => {
    const part = (p ?? {}) as Partial<UpdatePart>
    const name = typeof part.name === 'string' ? part.name : ''
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') bad('lists a part with an unsafe name')
    if (seen.has(name)) bad(`lists ${name} twice`)
    seen.add(name)
    const asset = typeof part.asset === 'string' ? part.asset : ''
    if (!asset) bad(`names no download for ${name}`)
    const sha = typeof part.sha256 === 'string' ? part.sha256.toLowerCase() : ''
    if (!HEX64.test(sha)) bad(`has no checksum for ${name}`)
    const tree = typeof part.tree === 'string' ? part.tree.toLowerCase() : ''
    if (!HEX64.test(tree)) bad(`has no content hash for ${name}`)
    const size = Number(part.size)
    if (!Number.isInteger(size) || size <= 0) bad(`has no size for ${name}`)
    return { name, asset, size, sha256: sha, tree }
  })
  return { format: MANIFEST_FORMAT, version, target, parts }
}
