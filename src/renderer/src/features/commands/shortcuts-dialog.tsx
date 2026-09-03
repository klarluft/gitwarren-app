/**
 * The `?` sheet.
 *
 * Generated from the same registry the keys are bound from, which means it
 * cannot go stale and it cannot be incomplete. It also means it is honest about
 * being contextual: the list is what works *here*, so opening it on the review
 * screen shows the review's keys and opening it at home does not pretend they
 * exist.
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { groupCommands, useCommands } from './command-registry'

export function ShortcutsDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const commands = useCommands()
  const sections = groupCommands(commands.filter((command) => command.keys !== undefined))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            These are the keys that work on this screen. Move to a repository or a review and the
            list grows.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 max-h-[60vh] overflow-y-auto px-1">
          {sections.map(([group, members]) => (
            <section key={group} className="mb-4 last:mb-0">
              <h3 className="mb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
              </h3>
              <ul className="flex flex-col">
                {members.map((command) => (
                  <li
                    key={command.id}
                    className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 text-sm odd:bg-muted/40"
                  >
                    <span className="min-w-0 truncate">{command.label}</span>
                    <Kbd binding={command.keys as string} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
          Shortcuts stay out of the way while you are typing: none of them fire inside a text field
          or while a dialog is open.
        </p>
      </DialogContent>
    </Dialog>
  )
}
