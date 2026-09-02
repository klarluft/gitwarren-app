/**
 * The keyboard layer of the app shell.
 *
 * It owns the shortcuts that make sense everywhere - the palette, the help
 * sheet, history, moving down a list - and it is the one place that turns the
 * registry into actual key bindings. Screens do not install listeners; they
 * declare commands and this binds whatever is currently declared.
 */
import { useCallback, useMemo, useState, type RefObject } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpToLine, Home, Keyboard, Search } from 'lucide-react'
import { formatStep } from '@/lib/keys'
import { useHotkeys, type Hotkey } from '@/lib/hotkeys'
import { goBack, navigate } from '@/lib/router'
import { CommandPalette } from './command-palette'
import { ShortcutsDialog } from './shortcuts-dialog'
import { bindableCommands, useCommands, useRegisterCommands, type Command } from './command-registry'

/**
 * Move focus to the next or previous row on the screen.
 *
 * Rows opt in with `data-nav-item`, and the browser's own focus is what moves -
 * there is no separate "selected row" state to keep in step with it. That means
 * Enter, Tab and a screen reader all agree about where you are, and a list only
 * has to mark its rows to join in.
 */
function moveFocus(delta: number): void {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-nav-item]')]
  if (rows.length === 0) return

  const current = rows.findIndex(
    (row) => row === document.activeElement || row.contains(document.activeElement)
  )
  // Nothing focused yet: `j` starts at the top and `k` at the bottom, which is
  // what each of them means when there is nowhere to come from.
  const next =
    current === -1
      ? delta > 0
        ? 0
        : rows.length - 1
      : Math.min(rows.length - 1, Math.max(0, current + delta))

  rows[next]?.focus()
  rows[next]?.scrollIntoView({ block: 'nearest' })
}

export function CommandCenter({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const scrollToTop = useCallback(() => {
    scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })
    scroller.current?.focus()
  }, [scroller])

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'app:palette',
        label: 'Command palette',
        group: 'Application',
        keys: 'mod+k',
        // `/` is the other muscle memory for "search", and costs nothing to
        // honour since bare keys already stand down inside text fields.
        aliases: ['/'],
        icon: Search,
        // Offering "open the palette" from inside the palette would be a joke
        // at the reader's expense; the help sheet still documents the key.
        hidden: true,
        run: () => setPaletteOpen(true)
      },
      {
        id: 'app:shortcuts',
        label: 'Keyboard shortcuts',
        group: 'Application',
        keys: '?',
        keywords: 'help keys bindings hotkeys',
        icon: Keyboard,
        run: () => setShortcutsOpen(true)
      },
      {
        id: 'nav:home',
        label: 'Go to repositories',
        group: 'Navigate',
        keys: 'g h',
        keywords: 'home start',
        icon: Home,
        run: () => navigate({ name: 'repositories' })
      },
      {
        id: 'nav:back',
        label: 'Back',
        group: 'Navigate',
        keys: 'mod+[',
        // The arrow form is the other macOS convention, and the only one some
        // keyboard layouts can produce without a modifier fight over brackets.
        aliases: ['mod+arrowleft'],
        icon: ArrowLeft,
        run: goBack
      },
      {
        id: 'nav:forward',
        label: 'Forward',
        group: 'Navigate',
        keys: 'mod+]',
        aliases: ['mod+arrowright'],
        icon: ArrowRight,
        run: () => window.history.forward()
      },
      {
        id: 'nav:top',
        label: 'Scroll to top',
        group: 'Navigate',
        keys: 'g t',
        icon: ArrowUpToLine,
        run: scrollToTop
      },
      {
        id: 'nav:next',
        label: 'Next item',
        group: 'Navigate',
        keys: 'j',
        hidden: true,
        run: () => moveFocus(1)
      },
      {
        id: 'nav:previous',
        label: 'Previous item',
        group: 'Navigate',
        keys: 'k',
        hidden: true,
        run: () => moveFocus(-1)
      }
    ],
    [scrollToTop]
  )

  useRegisterCommands(commands)

  return (
    <>
      <HotkeyLayer />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  )
}

/**
 * Binds every command currently in the registry, and shows a half-typed chord.
 *
 * Split out so that re-rendering on each pending keystroke redraws a pill in
 * the corner rather than the palette and the help sheet along with it.
 */
function HotkeyLayer() {
  const commands = useCommands()

  const hotkeys = useMemo<Hotkey[]>(
    () =>
      [...bindableCommands(commands)].map(([binding, command]) => ({
        binding,
        run: command.run
      })),
    [commands]
  )

  const pending = useHotkeys(hotkeys)
  if (pending === null) return null

  return (
    <div
      // Announced, because the app has just started waiting for a second key
      // and someone who cannot see the pill deserves to know that too.
      role="status"
      className="pointer-events-none fixed bottom-4 left-4 z-50 flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-md"
    >
      <span className="font-semibold text-foreground">{formatStep(pending)}</span>
      <span>waiting for the next key…</span>
    </div>
  )
}
