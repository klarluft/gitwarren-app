/**
 * Switch on Base UI's Switch primitive. Used for settings that take effect the
 * moment they change, with no separate confirmation - "include uncommitted
 * changes" being the one this app has.
 */
import { Switch as BaseSwitch } from '@base-ui/react/switch'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent',
        'bg-muted transition-colors data-[checked]:bg-primary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          'pointer-events-none block size-4 translate-x-0.5 rounded-full bg-background shadow-sm transition-transform',
          'data-[checked]:translate-x-[1.125rem]'
        )}
      />
    </BaseSwitch.Root>
  )
}
