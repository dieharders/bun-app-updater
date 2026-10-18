/**
 * One error type for everything the install path can refuse or fail at, with a CODE the UI can
 * branch on and a MESSAGE fit to show. Raw errnos and tool output stay in `cause`.
 */
export type InstallErrorCode =
  | 'blocked'
  | 'busy'
  | 'no_update'
  | 'already_installed'
  | 'in_progress'
  | 'offline'
  /** The feed lists no checksum for a download, so it cannot be verified; refused rather than installed on trust. */
  | 'unverified'
  | 'damaged'
  | 'unpack_failed'
  | 'swap_failed'
  | 'cancelled'

export class UpdateError extends Error {
  constructor(
    readonly code: InstallErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'UpdateError'
  }
}

export const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
