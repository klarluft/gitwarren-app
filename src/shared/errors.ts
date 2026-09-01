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
