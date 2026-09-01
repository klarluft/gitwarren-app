/**
 * Select on Base UI's Select primitive (keyboard typeahead, focus management
 * and the listbox ARIA wiring come from the primitive; the styling is ours).
 *
 * `alignItemWithTrigger` is turned off: the default lines the selected item up
 * over the trigger, which is the native macOS behaviour but jumps around
 * alarmingly in a list of a hundred branches. A plain dropdown below the
 * trigger is calmer and keeps the list in one place.
 */
import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronsUpDown } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Select = BaseSelect.Root
export const SelectGroup = BaseSelect.Group
export const SelectValue = BaseSelect.Value

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseSelect.Trigger>) {
  return (
    <BaseSelect.Trigger
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent',
        'px-3 py-1 text-sm shadow-sm transition-colors',
        'hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50',
        'data-[invalid]:border-destructive',
        className
      )}
      {...props}
    >
      {children}
      <BaseSelect.Icon className="shrink-0 text-muted-foreground">
        <ChevronsUpDown className="size-4" />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
  )
}

export function SelectContent({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseSelect.Popup>) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50">
        <BaseSelect.Popup
          className={cn(
            'max-h-[min(24rem,var(--available-height))] w-[var(--anchor-width)] min-w-[12rem] overflow-y-auto',
            'rounded-md border border-border bg-card p-1 text-card-foreground shadow-lg',
            'transition-[opacity,transform] duration-100',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            className
          )}
          {...props}
        >
          <BaseSelect.List>{children}</BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  )
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseSelect.Item>) {
  return (
    <BaseSelect.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none',
        'data-[highlighted]:bg-muted data-[highlighted]:text-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <BaseSelect.ItemText className="min-w-0 flex-1">{children}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="absolute right-2 flex items-center text-primary">
        <Check className="size-4" />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  )
}

export function SelectGroupLabel({
  className,
  ...props
}: ComponentProps<typeof BaseSelect.GroupLabel>) {
  return (
    <BaseSelect.GroupLabel
      className={cn(
        'px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}
