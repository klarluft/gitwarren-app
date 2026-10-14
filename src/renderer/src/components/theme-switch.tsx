/**
 * The light/dark switch: three icons in a pill, one of them lit.
 *
 * Three rather than a toggle, because there are three answers and "follow the
 * OS" is the one most people want. A two-way toggle has to either hide that
 * state behind a long-press or forget it the first time it is touched, and the
 * second means somebody who flipped to dark for one evening is stuck there
 * after their desktop has gone back to light.
 *
 * Kept quiet on purpose - no label, muted until hovered - because it is a
 * setting you touch once in a while, not a control the screen is about. The
 * palette carries the same three choices for anyone who would rather type.
 *
 * A radio group to assistive tech, with the arrow keys moving the choice and
 * one tab stop for the whole thing, which is how a group of radios behaves
 * everywhere else.
 */
import { useRef, type KeyboardEvent } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import {
  setThemePreference,
  THEME_PREFERENCES,
  useThemePreference,
  type ThemePreference
} from '@/lib/theme'
import { cn } from '@/lib/utils'

export const THEME_OPTIONS: Record<
  ThemePreference,
  { label: string; icon: typeof Sun }
> = {
  system: { label: 'Match system', icon: Monitor },
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon }
}

export function ThemeSwitch({ className }: { className?: string }) {
  const current = useThemePreference()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  function onKeyDown(event: KeyboardEvent): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0) return
    event.preventDefault()
    const count = THEME_PREFERENCES.length
    const index = (THEME_PREFERENCES.indexOf(current) + step + count) % count
    const next = THEME_PREFERENCES[index]
    if (next === undefined) return
    setThemePreference(next)
    buttons.current[index]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border p-0.5',
        className
      )}
    >
      {THEME_PREFERENCES.map((option, index) => {
        const { label, icon: Icon } = THEME_OPTIONS[option]
        const selected = option === current
        return (
          <Tooltip key={option} label={label} side="bottom">
            <button
              ref={(element) => {
                buttons.current[index] = element
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              tabIndex={selected ? 0 : -1}
              onClick={() => setThemePreference(option)}
              className={cn(
                // A finger-sized target on a phone, where there is no hover to
                // find it by and the pill is the only thing in its corner.
                'inline-flex size-6 items-center justify-center rounded-full max-sm:size-7',
                'text-muted-foreground transition-colors outline-none',
                'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                selected && 'bg-muted text-foreground'
              )}
            >
              <Icon className="size-3.5" />
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
