/**
 * Tooltips on Base UI's Tooltip primitive.
 *
 * These exist because `title` is not good enough for a control that is *only*
 * an icon. The browser decides when to show it - typically a second or more
 * after the pointer stops - it cannot be styled, it does not follow the app's
 * theme, and it never appears for keyboard users at all. A button whose whole
 * meaning is in its label cannot afford any of that.
 *
 * `TooltipProvider` at the root of the app supplies the shared timing, and its
 * grouping behaviour is the part worth having: the first tooltip waits, and
 * moving along a row of icon buttons then shows each one immediately instead of
 * re-waiting at every step.
 *
 * `title` is still right for text that is *supplementary* - the full path
 * behind a truncated one, the meaning of a badge. Those are not this.
 */
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function TooltipProvider({
  delay = 350,
  closeDelay = 0,
  ...props
}: ComponentProps<typeof BaseTooltip.Provider>) {
  return <BaseTooltip.Provider delay={delay} closeDelay={closeDelay} {...props} />
}

export interface TooltipProps {
  /** What the control does, in a few words. */
  label: ReactNode
  /** The control itself. Base UI merges its own props into this element. */
  children: ReactElement
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}

export function Tooltip({ label, children, side = 'top', className }: TooltipProps) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup
            className={cn(
              'max-w-64 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md',
              'transition-[opacity,transform] duration-100',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              className
            )}
          >
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
