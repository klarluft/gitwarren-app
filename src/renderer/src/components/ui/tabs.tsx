/**
 * Tabs on Base UI's Tabs primitive (roving focus, arrow-key navigation and the
 * tab/tabpanel ARIA wiring come from the primitive; the styling is ours).
 */
import { Tabs as BaseTabs } from '@base-ui/react/tabs'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Tabs = BaseTabs.Root

/**
 * The strip scrolls sideways rather than letting its tabs wrap.
 *
 * A tab is a fixed set of short labels and there is no useful second row for
 * them to go to: wrapping turned "Files changed" into two stacked words and
 * left the underline of the selected tab hanging under half of it. Scrolling
 * keeps every tab one line and one shape at any width, and the tabs that do not
 * fit stay reachable by dragging - which on the narrow window this is for is
 * the gesture already in the reader's hand.
 *
 * `scrollbar-width: none` because the strip is a few tabs, not a document, and
 * a scrollbar under them reads as an error. The overflow is still there for a
 * pointer to find; it is the bar that is hidden, not the scrolling.
 */
export function TabsList({ className, ...props }: ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List
      className={cn(
        'relative flex items-center gap-1 overflow-x-auto border-b border-border',
        '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
      {...props}
    />
  )
}

/**
 * The selected state arrives as `data-active`, not `data-selected`: Base UI
 * names the state on `Tabs.Tab` `active`, and the default state-to-attribute
 * mapping is what produces the attribute. Getting this wrong is silent - the
 * tab still works, it just never looks selected - so it is worth naming here.
 */
export function TabsTab({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        'group/tab relative -mb-px flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-md border-b-2 border-transparent px-3 py-2',
        'text-sm font-medium text-muted-foreground transition-colors',
        'hover:text-foreground',
        'data-[active]:border-primary data-[active]:font-semibold data-[active]:text-foreground',
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
        'group-data-[active]/tab:bg-primary/10 group-data-[active]/tab:text-foreground',
        className
      )}
      {...props}
    />
  )
}
