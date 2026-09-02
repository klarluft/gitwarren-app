/**
 * Key bindings as strings, and the two directions they have to travel.
 *
 * A binding is written the way it reads: `mod+k`, `shift+n`, `]`, or `g h` for
 * a two-step chord in the vim tradition. `mod` is the platform's own command
 * modifier - ⌘ on macOS, Ctrl everywhere else - so a binding is declared once
 * and is idiomatic on every platform GitWarren ships to.
 *
 * Two functions do the work. `eventToken` turns a real keystroke into the same
 * notation so matching is a string comparison, and `formatBinding` turns it
 * into the symbols a person expects to see on a menu. Both are pure and take
 * the platform as an argument, because the alternative is a module that cannot
 * be tested off a Mac.
 */

export type Platform = 'mac' | 'other'

/**
 * The parts of a key press this module reads.
 *
 * Structural rather than `Pick<KeyboardEvent, …>` so the module carries no DOM
 * types at all: its tests then run under the same node configuration as every
 * other test in the repository instead of needing one of their own. A real
 * `KeyboardEvent` satisfies it.
 */
export interface KeyPress {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function currentPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  // `userAgentData` is not everywhere yet and `platform` is deprecated but
  // still accurate in Electron, which is the only browser this app runs in.
  return /mac/i.test(navigator.userAgent) ? 'mac' : 'other'
}

/** Modifiers in the order a normalized token lists them. */
const MODIFIER_ORDER = ['mod', 'meta', 'ctrl', 'alt', 'shift'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

function isModifier(part: string): part is Modifier {
  return (MODIFIER_ORDER as readonly string[]).includes(part)
}

/**
 * A single step, with its modifiers put in a fixed order.
 *
 * Without this, `shift+mod+k` and `mod+shift+k` are two different strings for
 * one keystroke, and exactly one of them would ever fire.
 */
export function normalizeStep(step: string): string {
  const parts = step
    .trim()
    .toLowerCase()
    .split('+')
    .filter((part) => part.length > 0)

  const key = parts.filter((part) => !isModifier(part)).at(-1) ?? ''
  const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier))
  return [...modifiers, key].join('+')
}

/** The steps of a binding: one for `mod+k`, two for `g h`. */
export function bindingSteps(binding: string): string[] {
  return binding
    .trim()
    .split(/\s+/)
    .filter((step) => step.length > 0)
    .map(normalizeStep)
}

/**
 * Whether a shift press is part of the key or a modifier of it.
 *
 * On a US layout `?` *is* Shift+/, and the browser reports both - so a binding
 * written `?` would never match if shift were always folded into the token.
 * Shift only counts as a modifier when the key it decorates is one that shift
 * does not change: a letter, a digit, or a named key like Enter.
 */
function shiftIsModifier(key: string): boolean {
  return key.length > 1 || /^[a-z0-9]$/.test(key)
}

/** A keystroke in binding notation, or null for a bare modifier press. */
export function eventToken(event: KeyPress, platform: Platform = currentPlatform()): string | null {
  const key = event.key.toLowerCase()
  if (key === 'meta' || key === 'control' || key === 'alt' || key === 'shift') return null

  const parts: string[] = []
  // The non-`mod` modifier is still expressible: on a Mac, `ctrl+x` means the
  // control key literally, and on Windows `meta+x` means the Windows key.
  if (event.metaKey) parts.push(platform === 'mac' ? 'mod' : 'meta')
  if (event.ctrlKey) parts.push(platform === 'mac' ? 'ctrl' : 'mod')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey && shiftIsModifier(key)) parts.push('shift')
  parts.push(key)

  return normalizeStep(parts.join('+'))
}

const MAC_SYMBOLS: Record<string, string> = {
  mod: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧'
}

const OTHER_LABELS: Record<string, string> = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Win'
}

const KEY_LABELS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  enter: '↵',
  escape: 'Esc',
  backspace: '⌫',
  ' ': 'Space',
  '': ''
}

function labelForKey(key: string): string {
  return KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key.replace(/^./, (c) => c.toUpperCase()))
}

/**
 * One step rendered for the eye: `⌘K` on macOS, `Ctrl+K` elsewhere.
 *
 * Mac convention runs the symbols together; every other platform joins them
 * with a plus. Following each one is the difference between a shortcut that
 * looks native and one that looks ported.
 */
export function formatStep(step: string, platform: Platform = currentPlatform()): string {
  const parts = normalizeStep(step).split('+')
  const key = parts.at(-1) ?? ''
  const modifiers = parts.slice(0, -1)

  if (platform === 'mac') {
    return modifiers.map((modifier) => MAC_SYMBOLS[modifier] ?? '').join('') + labelForKey(key)
  }
  return [...modifiers.map((modifier) => OTHER_LABELS[modifier] ?? modifier), labelForKey(key)].join('+')
}

/** Every step of a binding, chords included: `g h` renders as `G` then `H`. */
export function formatBinding(binding: string, platform: Platform = currentPlatform()): string[] {
  return bindingSteps(binding).map((step) => formatStep(step, platform))
}
