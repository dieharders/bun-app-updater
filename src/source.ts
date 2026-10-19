/**
 * Where releases are announced.
 *
 * A `ReleaseSource` answers one question — what is the newest published release, with its
 * downloads — and nothing else. The updater decides whether that release is newer than the
 * running build and whether it has a download for this platform. Keeping the feed behind an
 * interface is what lets the same updater read GitHub Releases in production and a JSON file on
 * a loopback server in a test, with no branch in the install path.
 */
import { isAbort } from './errors'
import { parseVersion } from './version'

export interface ReleaseAsset {
  name: string
  url: string
  /** Byte count, for the progress bar and the completeness check. */
  size: number
  /** Lowercase hex SHA-256, or null when the feed does not publish one. */
  sha256: string | null
}

export interface Release {
  /** Strict `X.Y.Z`. */
  version: string
  /** A page a person can open: the release notes, or where to download by hand. */
  url: string
  assets: ReleaseAsset[]
}

export interface ReleaseSource {
  /**
   * The newest published release, or null when there is none. Throws a `ReleaseFeedError`, with
   * a message fit to show, when the feed cannot be read (offline, rate-limited, a broken
   * manifest). Anything else it throws is shown as "could not be reached", its text only logged.
   */
  latest(signal?: AbortSignal): Promise<Release | null>
}

/** A `fetch`-shaped function, injectable so the sources are tested without a network. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export class ReleaseFeedError extends Error {
  constructor(
    message: string,
    readonly code: 'offline' | 'rate_limited' | 'bad_feed',
  ) {
    super(message)
    this.name = 'ReleaseFeedError'
  }
}

const sha256Of = (digest: unknown): string | null => {
  if (typeof digest !== 'string') return null
  const [algo, hex] = digest.split(':')
  return algo === 'sha256' && hex && /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : null
}

export interface GithubReleasesOptions {
  /** `owner/name`. */
  repo: string
  /**
   * What a tag for THIS app's releases starts with; the version follows it. `v` for tags like
   * `v1.2.3`, something like `myapp-v` for a repo whose code has tags of its own.
   */
  tagPrefix: string
  /** Sent as the User-Agent, which GitHub requires. Usually the app's name. */
  userAgent: string
  fetch?: Fetch
  timeoutMs?: number
}

/**
 * GitHub Releases, read through `/releases/latest`: the release GitHub marks as the repo's
 * latest, which is never a draft or a prerelease. One request, whatever else the repo holds.
 *
 * THE REPO'S RELEASES MUST ALL BE THIS APP'S. `latest` is the repo's newest, whatever it is for,
 * and so are the `releases/latest/download/<name>` links a download page uses. So a release of
 * something else published there (a library sharing the repo) blocks updates as long as it is
 * the latest. Its tag will not carry `tagPrefix`, and that is answered as a feed error rather
 * than as "no release": "no release" would tell every installed copy it is up to date for as
 * long as that release stayed newest, and nobody would know.
 *
 * GitHub's latest, not the highest version: a release published for an older line becomes the
 * latest unless it is published with "Set as latest" unticked.
 */
export function githubReleases(opts: GithubReleasesOptions): ReleaseSource {
  const fetchFn = opts.fetch ?? fetch
  const url = `https://api.github.com/repos/${opts.repo}/releases/latest`
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': opts.userAgent }

  return {
    async latest(signal) {
      let res: Response
      try {
        res = await fetchFn(url, { headers, signal: anySignal(signal, opts.timeoutMs ?? 10_000) })
      } catch (err) {
        if (signal?.aborted) throw err
        throw new ReleaseFeedError('The release feed could not be reached. Check your connection and try again.', 'offline')
      }
      // No published release yet (or no such repo): nothing to offer.
      if (res.status === 404) return null
      if (res.status === 403 || res.status === 429) {
        throw new ReleaseFeedError('GitHub is turning away update requests for now. Try again in an hour.', 'rate_limited')
      }
      if (!res.ok) throw new ReleaseFeedError(`GitHub did not answer about updates (${res.status}). Try again later.`, 'bad_feed')

      // The body is read under the same signal and timeout as the request, and fails the same
      // ways: a timeout half way is the network; a page that isn't JSON (a captive portal's) is the feed.
      let r: Partial<GithubRelease> | null
      try {
        r = (await res.json()) as Partial<GithubRelease> | null
      } catch (err) {
        if (signal?.aborted) throw err
        if (isAbort(err)) throw new ReleaseFeedError('The release feed could not be reached. Check your connection and try again.', 'offline')
        throw new ReleaseFeedError('The release feed is not valid JSON.', 'bad_feed')
      }
      if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.tag_name !== 'string') {
        throw new ReleaseFeedError('The release feed is not in the expected shape.', 'bad_feed')
      }

      const version = r.tag_name.startsWith(opts.tagPrefix) ? r.tag_name.slice(opts.tagPrefix.length) : ''
      if (!parseVersion(version)) {
        throw new ReleaseFeedError(`The release feed's newest release (${r.tag_name}) is not one of this app's.`, 'bad_feed')
      }
      return {
        version,
        url: typeof r.html_url === 'string' ? r.html_url : '',
        assets: (r.assets ?? []).map((a) => ({
          name: a.name,
          url: a.browser_download_url,
          size: Number(a.size) || 0,
          sha256: sha256Of(a.digest),
        })),
      }
    },
  }
}

/** The parts of GitHub's release JSON read here. */
interface GithubRelease {
  tag_name: string
  html_url: string
  assets?: { name: string; browser_download_url: string; size: number; digest?: string | null }[]
}

/**
 * A JSON manifest at any URL, in `Release`'s own shape:
 *
 *   { "version": "1.2.3", "url": "https://…/notes", "assets": [{ "name", "url", "size", "sha256" }] }
 *
 * For a release feed an app hosts itself, and for testing an update end to end against a local
 * file server with nothing published anywhere. `file:` URLs are read from disk.
 */
export function jsonRelease(manifestUrl: string, fetchFn: Fetch = fetch): ReleaseSource {
  return {
    async latest(signal) {
      let text: string
      try {
        if (manifestUrl.startsWith('file:')) {
          text = await Bun.file(Bun.fileURLToPath(manifestUrl)).text()
        } else {
          const res = await fetchFn(manifestUrl, { signal: anySignal(signal, 10_000) })
          if (res.status === 404) return null
          if (!res.ok) throw new ReleaseFeedError(`The release feed answered ${res.status}.`, 'bad_feed')
          text = await res.text()
        }
      } catch (err) {
        if (err instanceof ReleaseFeedError || signal?.aborted) throw err
        throw new ReleaseFeedError('The release feed could not be reached. Check your connection and try again.', 'offline')
      }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        throw new ReleaseFeedError('The release feed is not valid JSON.', 'bad_feed')
      }
      return asRelease(raw)
    },
  }
}

/** A fixed answer, for tests and for an app that resolves its release some other way. */
export function staticRelease(release: Release | null): ReleaseSource {
  return { latest: async () => release }
}

function asRelease(raw: unknown): Release {
  const r = raw as Partial<Release> | null
  if (!r || typeof r !== 'object' || typeof r.version !== 'string' || !parseVersion(r.version) || !Array.isArray(r.assets)) {
    throw new ReleaseFeedError('The release feed is not in the expected shape.', 'bad_feed')
  }
  return {
    version: r.version,
    url: typeof r.url === 'string' ? r.url : '',
    assets: r.assets.map((a) => {
      const asset = a as Partial<ReleaseAsset>
      if (typeof asset.name !== 'string' || typeof asset.url !== 'string') {
        throw new ReleaseFeedError('The release feed lists a download without a name or url.', 'bad_feed')
      }
      const sha = typeof asset.sha256 === 'string' ? asset.sha256.toLowerCase() : null
      return { name: asset.name, url: asset.url, size: Number(asset.size) || 0, sha256: sha && /^[0-9a-f]{64}$/.test(sha) ? sha : null }
    }),
  }
}

/** A signal that fires on the caller's signal or after `timeoutMs`, whichever is first. */
export function anySignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
