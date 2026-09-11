/**
 * Turning errors from the main process into things the UI can render.
 *
 * The preload script rebuilds a real `AppError` on this side, so the code and
 * any field-level messages survive the IPC hop and the forms can show a message
 * next to the offending input instead of a generic banner.
 */
import { AppError, type AppErrorCode } from '@shared/errors'

export function errorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

export function errorCode(error: unknown): AppErrorCode | null {
  return error instanceof AppError ? error.code : null
}

/**
 * A failure that says nothing about the data - the question could not be asked.
 *
 * The distinction M4.5 turns on. Every other error is an *answer* about what
 * was asked for, and replaces what is on screen because it contradicts it; a
 * disconnection contradicts nothing, so the screen keeps what it had and the
 * banner says it is stale. See `features/hosts/host-banner.tsx`.
 */
export function isDisconnection(error: unknown): boolean {
  return errorCode(error) === 'HOST_OFFLINE'
}

/** Field-level messages keyed by form field, ready to render inline. */
export function fieldErrors(error: unknown): Record<string, string[]> {
  return error instanceof AppError && error.fieldErrors ? error.fieldErrors : {}
}

export function firstFieldError(error: unknown, field: string): string | undefined {
  return fieldErrors(error)[field]?.[0]
}
