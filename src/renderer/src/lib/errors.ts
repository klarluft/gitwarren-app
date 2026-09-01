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

/** Field-level messages keyed by form field, ready to render inline. */
export function fieldErrors(error: unknown): Record<string, string[]> {
  return error instanceof AppError && error.fieldErrors ? error.fieldErrors : {}
}

export function firstFieldError(error: unknown, field: string): string | undefined {
  return fieldErrors(error)[field]?.[0]
}
