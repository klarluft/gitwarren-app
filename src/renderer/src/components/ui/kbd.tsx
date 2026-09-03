/**
 * A key, drawn as a key.
 *
 * A chord renders as one cap per step - `G` `H` - rather than as the string
 * "g h", because the two steps are pressed one after the other and the gap
 * between the caps is what says so.
 */
import { formatBinding } from '@/lib/keys'
import { cn } from '@/lib/utils'

export function Kbd({ binding, className }: { binding: string; className?: string }) {
  return (
    // The caps are decorative duplicates of the label they sit beside; screen
    // readers get the shortcut from the row's own text, not from these.
    <span className="inline-flex items-center gap-1" aria-hidden>
      {formatBinding(binding).map((step, index) => (
        <kbd
          key={index}
          className={cn(
            'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border',
            'bg-muted px-1.5 font-sans text-[0.6875rem] font-medium leading-none text-muted-foreground',
            className
          )}
        >
          {step}
        </kbd>
      ))}
    </span>
  )
}
