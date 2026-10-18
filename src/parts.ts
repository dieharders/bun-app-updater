/**
 * The build side: write a release's update parts and manifest from a staged install tree.
 *
 * One zip per top-level entry of the tree (or the one `.app` for a bundle), each named by the
 * app, plus the manifest (manifest.ts) recording each part's size, SHA-256 and content hash.
 * Every part is then READ BACK WITH THE UPDATER'S OWN CODE — opened by `readZipEntries`,
 * unpacked by `unzipToDir`, hashed by `hashTree` — and compared with what was staged. A part the
 * build can write but the updater cannot read, or one whose unpacked content hashes differently
 * from the staged entry (which would make the updater download it on every update, forever),
 * fails on the build machine rather than on a user's.
 *
 * The archivers are the platform's own, chosen so that what the updater unpacks matches what
 * it would see in an install:
 *   - macOS: `ditto -c -k --keepParent` of the sealed bundle, which the updater unpacks with
 *     ditto too, so symlinks, modes and the code signature survive byte for byte.
 *   - Windows: Windows' own tar.exe (bsdtar, in every Windows 10 since 1803 and on GitHub's
 *     runners), by full path — a bare `tar` resolves to Git for Windows' GNU tar wherever Git
 *     is on PATH, which reads `C:\…` as a remote host and writes nothing.
 *   - Linux: Info-ZIP with `-y`, so exec bits and symlinks land in the central directory, which
 *     the updater reads back.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MANIFEST_FORMAT, type UpdateManifest, type UpdatePart } from './manifest'
import { hashTree } from './tree-hash'
import { applyZipModes, readZipEntries, unzipToDir } from './zip'

export interface WritePartsOptions {
  /** The staged install tree: the executable and its sibling directories, or the `.app`'s parent. */
  sourceDir: string
  /** Where the zips and the manifest are written. Emptied first, so an older version's parts are never published beside these. */
  outDir: string
  /** Strict `X.Y.Z`. */
  version: string
  /** The platform name the updater asks for: `windows-x64`, `darwin-arm64`, … */
  target: string
  /** The platform the tree is FOR, which need not be this machine's. */
  platform: NodeJS.Platform
  /** The manifest's file name, as the app's `manifestName(version, target)` would name it. */
  manifestName: string
  /** A part's zip file name, from the entry it holds (`vendor`, `motionbuff.exe`, `MyApp.app`). */
  partName: (entry: string) => string
  /** macOS: the bundle's name in `sourceDir`. The one part; nothing else in the directory is read. */
  bundle?: string
  /** Entries at the top of `sourceDir` to leave out (an un-installed tree's launcher files). Dotfiles are always left out. */
  skip?: string[]
  /** Entries that must be present, or the tree is an incomplete build. */
  required?: string[]
  /** Linux: paths (relative to `sourceDir`) the zips must record as executable, e.g. `vendor/ffmpeg`. */
  executables?: string[]
  log?: (line: string) => void
}

export interface WrittenParts {
  manifestPath: string
  manifest: UpdateManifest
  /** The manifest and every part, absolute, in the order to publish them. */
  files: string[]
}

export async function writeUpdateParts(opts: WritePartsOptions): Promise<WrittenParts> {
  const log = opts.log ?? (() => {})
  const { sourceDir, outDir, platform } = opts
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  let entries: string[]
  if (platform === 'darwin') {
    if (!opts.bundle) throw new Error('writeUpdateParts: a macOS release needs `bundle`, the .app to ship as its one part')
    entries = [opts.bundle]
  } else {
    const skip = new Set(opts.skip ?? [])
    entries = fs.readdirSync(sourceDir).filter((e) => !skip.has(e) && !e.startsWith('.')).sort()
  }
  const missing = (opts.required ?? []).filter((r) => !entries.includes(r))
  if (missing.length > 0) throw new Error(`${sourceDir} is missing ${missing.join(', ')}; the build did not stage completely`)
  if (entries.length === 0) throw new Error(`${sourceDir} has nothing to ship`)

  const parts: UpdatePart[] = []
  for (const name of entries) {
    const out = path.join(outDir, opts.partName(name))
    if (platform === 'darwin') {
      await run(['ditto', '-c', '-k', '--norsrc', '--noextattr', '--keepParent', path.join(sourceDir, name), out])
    } else if (platform === 'win32') {
      await run([path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), '-a', '-cf', out, '-C', sourceDir, name])
    } else {
      await run(['zip', '-r', '-q', '-y', out, name], sourceDir)
    }
    const tree = (await hashTree(path.join(sourceDir, name)))!
    const size = fs.statSync(out).size
    parts.push({ name, asset: path.basename(out), size, sha256: await sha256Of(out), tree })
    log(`${path.basename(out)}  ${mb(size)}`)
  }

  // The tripwire: what the updater will see.
  for (const part of parts) {
    const zip = path.join(outDir, part.asset)
    const zipEntries = readZipEntries(zip)
    const top = new Set(zipEntries.map((e) => e.name.replace(/\\/g, '/').split('/').filter(Boolean)[0]!))
    if (top.size !== 1 || !top.has(part.name)) throw new Error(`${part.asset} should hold ${part.name} at its top level and nothing else (has: ${[...top].join(', ')})`)
    if (zipEntries.length >= 65535) throw new Error(`${part.asset} has ${zipEntries.length} entries; the updater's reader stops at 65535`)
    if (platform === 'darwin') continue // ditto's zips are unpacked by ditto, and a bundle is never hashed by the updater
    if (platform === 'linux') {
      for (const exe of (opts.executables ?? []).filter((e) => e.split('/')[0] === part.name)) {
        const entry = zipEntries.find((e) => e.name === exe)
        if (!entry?.mode || !(entry.mode & 0o111)) throw new Error(`${part.asset} does not record ${exe} as executable; the updater would unpack something nothing can run`)
      }
    }
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'update-parts-check-'))
    try {
      await unzipToDir(zip, scratch)
      applyZipModes(zip, scratch, platform)
      const unpacked = await hashTree(path.join(scratch, part.name))
      if (unpacked !== part.tree) throw new Error(`${part.asset} unpacks to a ${part.name} whose content hash differs from the staged one; the updater would never see it as current`)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  }

  const manifest: UpdateManifest = { format: MANIFEST_FORMAT, version: opts.version, target: opts.target, parts }
  const manifestPath = path.join(outDir, opts.manifestName)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  log(`${opts.manifestName}: ${parts.length} parts, ${mb(parts.reduce((n, p) => n + p.size, 0))} in all`)
  return { manifestPath, manifest, files: [manifestPath, ...parts.map((p) => path.join(outDir, p.asset))] }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject))
  return hash.digest('hex')
}

async function run(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${path.basename(cmd[0]!)} failed (${code}):\n${(err || out).trim().split('\n').slice(-12).join('\n')}`)
}
