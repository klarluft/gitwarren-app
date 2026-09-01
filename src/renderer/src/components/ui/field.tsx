/**
 * Form field built on Base UI's Field primitive, which wires the label,
 * control, description and error message together with the right ARIA
 * relationships. Validation messages are passed in from zod or from the
 * service, so the UI never decides what counts as valid.
 */
import { Field as BaseField } from '@base-ui/react/field'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Field({ className, ...props }: ComponentProps<typeof BaseField.Root>) {
  return <BaseField.Root className={cn('flex flex-col gap-1.5', className)} {...props} />
}

export function FieldLabel({ className, ...props }: ComponentProps<typeof BaseField.Label>) {
  return (
    <BaseField.Label
      className={cn('text-sm font-medium leading-none text-foreground', className)}
      {...props}
    />
  )
}

export function FieldDescription({
  className,
  ...props
}: ComponentProps<typeof BaseField.Description>) {
  return (
    <BaseField.Description className={cn('text-xs text-muted-foreground', className)} {...props} />
  )
}

/** Renders nothing when `children` is undefined, so layout doesn't jump. */
export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <p role="alert" className="text-xs font-medium text-destructive">
      {children}
    </p>
  )
}
