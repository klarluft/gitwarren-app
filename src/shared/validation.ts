/**
 * One zod-error-to-AppError conversion, used by the service layer and by the
 * React forms.
 *
 * Sharing it means a value rejected in the form is rejected identically by the
 * service (and by MCP), and the resulting `fieldErrors` have the same shape
 * whether they were produced locally or came back over IPC - so the form can
 * render both through the same code path.
 */
import { z } from 'zod'
import { AppError } from './errors.js'

export function parseWithSchema<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input)
  if (result.success) return result.data

  const flattened = z.flattenError(result.error) as {
    formErrors: string[]
    fieldErrors: Record<string, string[] | undefined>
  }

  const fieldErrors: Record<string, string[]> = {}
  for (const [field, messages] of Object.entries(flattened.fieldErrors)) {
    if (messages && messages.length > 0) fieldErrors[field] = messages
  }

  const message =
    flattened.formErrors[0] ??
    Object.values(fieldErrors)[0]?.[0] ??
    'The values provided are not valid.'

  throw new AppError('INVALID_INPUT', message, fieldErrors)
}
