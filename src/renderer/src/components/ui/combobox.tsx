/**
 * Combobox on Base UI's Combobox primitive - a select you can type into.
 *
 * The search field lives *inside* the popup rather than replacing the trigger.
 * That keeps the closed control reading as a value ("main") rather than as an
 * empty text box, while still putting a query one keystroke away once it is
 * open; Base UI clears the query when the popup closes, so the field never
 * holds a stale search.
 *
 * The popup deliberately refuses to inherit the trigger's width. A trigger can
 * be half of a narrow dialog, and a list of branch names read at that width is
 * the problem this component exists to solve - so the popup takes the wider of
 * the anchor and its own floor, capped only by what the window has.
 */
import { Combobox as BaseCombobox } from '@base-ui/react/combobox'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Combobox = BaseCombobox.Root
export const ComboboxValue = BaseCombobox.Value
export const ComboboxCollection = BaseCombobox.Collection

export function ComboboxTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseCombobox.Trigger>) {
  return (
    <BaseCombobox.Trigger
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent',
        'px-3 py-1 text-left text-sm shadow-sm transition-colors',
        'hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50',
        'data-[invalid]:border-destructive',
        className
      )}
      {...props}
    >
      {children}
      <BaseCombobox.Icon className="shrink-0 text-muted-foreground">
        <ChevronsUpDown className="size-4" />
      </BaseCombobox.Icon>
    </BaseCombobox.Trigger>
  )
}

/**
 * The popup shell. `minWidth` is the floor the list may widen to, independent
 * of the trigger; callers set it from how wide their content actually needs to
 * be rather than from how wide the field happens to be.
 */
export function ComboboxContent({
  className,
  children,
  minWidth = '24rem',
  ...props
}: ComponentProps<typeof BaseCombobox.Popup> & { minWidth?: string }) {
  return (
    <BaseCombobox.Portal>
      <BaseCombobox.Positioner align="start" sideOffset={4} className="z-50 outline-none">
        <BaseCombobox.Popup
          style={{ width: `max(var(--anchor-width), ${minWidth})` }}
          className={cn(
            'flex max-h-[min(28rem,var(--available-height))] max-w-[var(--available-width)] flex-col',
            'overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-lg',
            'transition-[opacity,transform] duration-100',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            className
          )}
          {...props}
        >
          {children}
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  )
}

export function ComboboxInput({ className, ...props }: ComponentProps<typeof BaseCombobox.Input>) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3">
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <BaseCombobox.Input
        className={cn(
          'h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground',
          className
        )}
        {...props}
      />
    </div>
  )
}

export function ComboboxList({ className, ...props }: ComponentProps<typeof BaseCombobox.List>) {
  return (
    <BaseCombobox.List
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 outline-none', className)}
      {...props}
    />
  )
}

/**
 * The "nothing matched" line.
 *
 * Base UI keeps this element mounted whatever the list is doing - it is the
 * live region that announces the result count - and only swaps its children
 * out. So the padding has to be conditional too: `empty:p-0` is what stops a
 * silent, childless div from leaving a blank band above the first group.
 */
export function ComboboxEmpty({ className, ...props }: ComponentProps<typeof BaseCombobox.Empty>) {
  return (
    <BaseCombobox.Empty
      className={cn('px-3 py-6 text-center text-sm text-muted-foreground empty:p-0', className)}
      {...props}
    />
  )
}

export function ComboboxGroup({ className, ...props }: ComponentProps<typeof BaseCombobox.Group>) {
  return <BaseCombobox.Group className={cn('block pb-1 last:pb-0', className)} {...props} />
}

export function ComboboxGroupLabel({
  className,
  ...props
}: ComponentProps<typeof BaseCombobox.GroupLabel>) {
  return (
    <BaseCombobox.GroupLabel
      className={cn(
        'px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

export function ComboboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseCombobox.Item>) {
  return (
    <BaseCombobox.Item
      className={cn(
        'relative flex cursor-default select-none items-start gap-2 rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none',
        'data-[highlighted]:bg-muted data-[highlighted]:text-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      {children}
      <BaseCombobox.ItemIndicator className="absolute right-2 top-1.5 flex items-center text-primary">
        <Check className="size-4" />
      </BaseCombobox.ItemIndicator>
    </BaseCombobox.Item>
  )
}
