/**
 * Checkbox on Base UI's Checkbox primitive.
 *
 * The sibling of `switch.tsx`, and the difference between them is what they
 * mean rather than how they look: a switch changes what the screen is showing,
 * a checkbox records something about the thing on it. "Reviewed" is the second
 * kind - it is a note the reviewer leaves behind, not a view setting.
 */
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox'
import { Check } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Checkbox({ className, ...props }: ComponentProps<typeof BaseCheckbox.Root>) {
  return (
    <BaseCheckbox.Root
      className={cn(
        'flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border border-border',
        'bg-background transition-colors data-[checked]:border-primary data-[checked]:bg-primary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <BaseCheckbox.Indicator className="flex text-primary-foreground">
        <Check className="size-3" strokeWidth={3} />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  )
}
