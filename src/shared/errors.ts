/**
 * Error vocabulary shared by every surface: the core services raise these, the
 * IPC layer serialises them, and both the React UI and the MCP server map them
 * back to something a human or an agent can act on.
 *
 * Plain JS only - this module is imported by the renderer as well as by Node.
 */

export const APP_ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'PATH_NOT_FOUND',
  'NOT_A_GIT_REPOSITORY',
  'DUPLICATE_REPOSITORY',
  /**
   * The caller may not touch this record. Not an authentication failure - there
   * is nothing to authenticate against here - but the one rule the app does
   * enforce: an agent can edit and delete its own comments and no one else's.
   */
  'FORBIDDEN',
  'GIT_UNAVAILABLE',
  /**
   * The host that owns this data could not be reached, or stopped answering
   * while we were asking.
   *
   * The one code whose right response is usually to wait rather than to change
   * anything, which is why it is not folded into `INTERNAL`: nothing is broken,
   * a machine is asleep. It is also the only code a screen is allowed to keep
   * showing stale content underneath - see the disconnection banner in M4.5 -
   * because the alternative is blanking a review someone is reading over a
   * thirty-second network blip.
   *
   * A request that fails this way was *not* necessarily un-answered: the daemon
   * may have done the work and lost the reply on the way back. So a carrier
   * never retries a write on it. See `core/rpc/stdio-client.ts`.
   */
  'HOST_OFFLINE',
  /**
   * A route or a link names an install this one has never been told about.
   *
   * Split out of `NOT_FOUND` because the two lead somewhere different and a
   * screen that cannot tell them apart says the wrong thing. `NOT_FOUND` is an
   * answer *about the data*: the machine was asked and has no review 4. This is
   * not an answer at all - nothing was asked, because there is nowhere to ask.
   * Heading a screen "Review not found" on this code blames the review for the
   * absence of the machine, which is the confusion M6.8 exists to remove.
   *
   * It is also not a disconnection, and the distinction matters in both
   * directions. A disconnection keeps stale content on screen because the data
   * is probably still true; there is no stale content here, because this route
   * never loaded anything. And an unknown host must not be recorded as
   * *answering* either - see `lib/api.ts`, where every other non-disconnection
   * error is proof the far end is there. This one is proof of nothing.
   */
  'UNKNOWN_HOST',
  'INTERNAL'
] as const

export type AppErrorCode = (typeof APP_ERROR_CODES)[number]

export interface SerializedAppError {
  code: AppErrorCode
  message: string
  /** Field-level messages, keyed by form field name. Drives inline form errors. */
  fieldErrors?: Record<string, string[]>
}

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly fieldErrors?: Record<string, string[]>

  constructor(code: AppErrorCode, message: string, fieldErrors?: Record<string, string[]>) {
    super(message)
    this.name = 'AppError'
    this.code = code
    if (fieldErrors) this.fieldErrors = fieldErrors
  }

  toSerialized(): SerializedAppError {
    return {
      code: this.code,
      message: this.message,
      ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {})
    }
  }

  static from(error: unknown): AppError {
    if (error instanceof AppError) return error
    const message = error instanceof Error ? error.message : String(error)
    return new AppError('INTERNAL', message)
  }
}

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && (APP_ERROR_CODES as readonly string[]).includes(value)
}

export function deserializeAppError(serialized: SerializedAppError): AppError {
  return new AppError(serialized.code, serialized.message, serialized.fieldErrors)
}
