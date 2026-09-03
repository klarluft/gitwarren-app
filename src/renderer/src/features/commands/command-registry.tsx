/**
 * The command registry: one description of what the app can do, three ways to
 * reach it.
 *
 * Every action worth a shortcut is declared once, as a `Command`. The palette
 * lists it, the hotkey layer binds its keys, and the shortcuts sheet documents
 * it - all from the same object. That is the point of doing it this way: a
 * shortcut cannot exist without also being discoverable, and a key printed in
 * the help sheet cannot drift away from the key that actually fires, because
 * there is only one of them.
 *
 * Screens contribute their own commands while they are on screen and withdraw
 * them on the way out, so `]` means "next file" only where a next file exists,
 * and nothing has to maintain a list of which shortcut applies where.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode
} from 'react'

/**
 * Palette sections, in the order they appear.
 *
 * The order is the interesting part: what you can do *here* comes before what
 * you can go to, because a palette opened mid-review is usually opened to act
 * rather than to leave.
 */
export const COMMAND_GROUPS = [
  'Review',
  'Files changed',
  'Jump to file',
  'Repository',
  'Navigate',
  'Reviews',
  'Repositories',
  'Application'
] as const

export type CommandGroup = (typeof COMMAND_GROUPS)[number]

export interface Command {
  /** Stable across renders; used as the React key and for the active row. */
  id: string
  label: string
  group: CommandGroup
  run: () => void
  /** Matched against, never shown - aliases and synonyms belong here. */
  keywords?: string
  /** Secondary text on the right of the row: a path, a repository name. */
  hint?: string
  icon?: ComponentType<{ className?: string }>
  /** `mod+k`, `]`, `g h`. Bound by the hotkey layer, shown in both surfaces. */
  keys?: string
  /** Bound as well, but not shown - `mod+arrowleft` alongside `mod+[`. */
  aliases?: string[]
  /**
   * Keep it out of the palette. For shortcuts that are only meaningful as
   * keystrokes: "next item" is not something anyone picks off a list.
   */
  hidden?: boolean
  /** Listed and matched, but inert - explains why the key is doing nothing. */
  disabled?: boolean
}

interface Registry {
  register: (key: symbol, commands: Command[]) => void
  unregister: (key: symbol) => void
}

const RegistryContext = createContext<Registry | null>(null)
const CommandsContext = createContext<Command[]>([])

export function CommandRegistryProvider({ children }: { children: ReactNode }) {
  const [registrations, setRegistrations] = useState<Map<symbol, Command[]>>(() => new Map())

  const registry = useMemo<Registry>(
    () => ({
      register(key, commands) {
        setRegistrations((previous) => new Map(previous).set(key, commands))
      },
      unregister(key) {
        setRegistrations((previous) => {
          if (!previous.has(key)) return previous
          const next = new Map(previous)
          next.delete(key)
          return next
        })
      }
    }),
    []
  )

  // Insertion order is registration order, which is mount order: the app's own
  // commands first, then the screen's, then the tab's. Later wins on a key
  // clash (see `bindableCommands`), so the most specific screen takes the key.
  const commands = useMemo(() => [...registrations.values()].flat(), [registrations])

  return (
    <RegistryContext.Provider value={registry}>
      <CommandsContext.Provider value={commands}>{children}</CommandsContext.Provider>
    </RegistryContext.Provider>
  )
}

/**
 * Contribute commands for as long as this component is mounted.
 *
 * `commands` must be memoized by the caller - it goes straight into an effect's
 * dependencies, and a fresh array every render would re-register in a loop.
 */
export function useRegisterCommands(commands: Command[]): void {
  const registry = useContext(RegistryContext)
  const key = useMemo(() => Symbol('commands'), [])

  useEffect(() => {
    if (!registry) return
    registry.register(key, commands)
    return () => registry.unregister(key)
  }, [registry, key, commands])
}

export function useCommands(): Command[] {
  return useContext(CommandsContext)
}

/** Look up one command by id, for a caller that wants to run it directly. */
export function useRunCommand(): (id: string) => void {
  const commands = useCommands()
  return useCallback(
    (id) => {
      const command = commands.find((candidate) => candidate.id === id)
      if (command && !command.disabled) command.run()
    },
    [commands]
  )
}

/**
 * The commands that should actually own a key right now, clashes resolved.
 *
 * Two screens can both want `r`, and only one of them is on screen - but the
 * registry is flat, so the tie is broken here, in favour of whoever registered
 * last. Mount order runs shell → screen → tab, so "last" means "most specific",
 * which is the one the reader is looking at.
 */
export function bindableCommands(commands: Command[]): Map<string, Command> {
  const byBinding = new Map<string, Command>()

  for (const command of commands) {
    if (command.disabled) continue
    for (const binding of [command.keys, ...(command.aliases ?? [])]) {
      if (binding !== undefined) byBinding.set(binding, command)
    }
  }

  return byBinding
}

/** Commands grouped for display, empty groups dropped, order preserved. */
export function groupCommands(commands: Command[]): [CommandGroup, Command[]][] {
  return COMMAND_GROUPS.map(
    (group) =>
      [group, commands.filter((command) => command.group === group)] as [CommandGroup, Command[]]
  ).filter(([, members]) => members.length > 0)
}
