/**
 * Versions are strict `X.Y.Z`, nothing else.
 *
 * No prerelease or build-metadata support, on purpose. A release feed carries one stream of
 * published versions, and anything that is not three numbers — `nightly`, `1.2.0-beta.1`, a
 * library's own tag that shares the repo — is NOT an update, rather than something to rank. A
 * tag the updater cannot parse is ignored where it is read (see source.ts), never guessed at.
 */
export type Version = readonly [number, number, number]

export function parseVersion(s: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. Unparseable = oldest. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va && !vb) return 0
  if (!va) return -1
  if (!vb) return 1
  for (let i = 0; i < 3; i++) {
    if (va[i]! !== vb[i]!) return va[i]! < vb[i]! ? -1 : 1
  }
  return 0
}
