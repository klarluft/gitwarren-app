/**
 * Tabs on Base UI's Tabs primitive (roving focus, arrow-key navigation and the
 * tab/tabpanel ARIA wiring come from the primitive; the styling is ours).
 */
import { Tabs as BaseTabs } from '@base-ui/react/tabs'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Tabs = BaseTabs.Root

export function TabsList({ className, ...props }: ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List
      className={cn('relative flex items-center gap-1 border-b border-border', className)}
      {...props}
    />
  )
}

export function TabsTab({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        'relative -mb-px flex items-center gap-2 rounded-t-md border-b-2 border-transparent px-3 py-2',
        'text-sm font-medium text-muted-foreground transition-colors',
        'hover:text-foreground',
        'data-[selected]:border-primary data-[selected]:text-foreground',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className
      )}
      {...props}
    />
  )
}

export function TabsPanel({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) {
  return <BaseTabs.Panel className={cn('pt-4', className)} {...props} />
}

/**
 * The small count pill next to a tab label - "Files changed 12". Muted when the
 * tab is not selected so it reads as secondary to the label.
 */
export function TabsCount({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'rounded-full bg-muted px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-none text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}
