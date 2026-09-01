/**
 * Handing a file to the user's code editor.
 *
 * There is no reliable "the user's editor" on any desktop platform, so this
 * asks two cheap questions instead of guessing: is the application installed,
 * and does it have a way to be told a line number. Everything found is offered
 * to the UI, which lets the reviewer pick - a machine with both VS Code and
 * Cursor on it has no correct default, only a preference.
 *
 * Two launch mechanisms, in this order:
 *
 *  - **A URL scheme** (`vscode://file/...`), handed to `shell.openExternal`.
 *    Registered by the application itself at install time, so it works without
 *    the user ever having installed a shell command, and it carries the line.
 *  - **A CLI on PATH** (`code -g file:line`), for editors with no scheme worth
 *    using and for the `GITWARREN_EDITOR` escape hatch.
 *
 * `GITWARREN_EDITOR` overrides all of it: either the id of an editor below, or
 * a command template such as `emacsclient +{line} {file}`. It is read from the
 * environment rather than stored as a setting because this app has no settings
 * screen, and the people who need something other than the five editors below
 * are the same people who already keep `EDITOR` set.
 */
import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { shell } from 'electron'
import { AppError } from '../shared/errors.js'
import type { EditorInfo } from '../shared/api.js'

interface EditorDefinition {
  id: string
  label: string
  /** macOS application bundle, looked for in the usual two places. */
  appBundle?: string
  /** Windows application path, relative to a well-known root. */
  windowsPath?: string
  /** Command to look for on PATH. */
  bin?: string
  /** Preferred launch: a URL the application registered for itself. */
  url?: (path: string, line: number) => string
  /** Fallback launch: arguments for `bin`. */
  cliArgs?: (path: string, line: number) => string[]
}

/**
 * Order is the order the UI offers them in, and the first one found is the
 * default. It is a judgement call rather than a fact; the picker exists so the
 * judgement does not have to be right.
 */
const EDITORS: EditorDefinition[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    appBundle: 'Visual Studio Code.app',
    windowsPath: 'Microsoft VS Code\\Code.exe',
    bin: 'code',
    url: (path, line) => `vscode://file${encodeURI(path)}:${line}`,
    cliArgs: (path, line) => ['--goto', `${path}:${line}`]
  },
  {
    id: 'cursor',
    label: 'Cursor',
    appBundle: 'Cursor.app',
    windowsPath: 'cursor\\Cursor.exe',
    bin: 'cursor',
    url: (path, line) => `cursor://file${encodeURI(path)}:${line}`,
    cliArgs: (path, line) => ['--goto', `${path}:${line}`]
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    appBundle: 'Windsurf.app',
    bin: 'windsurf',
    url: (path, line) => `windsurf://file${encodeURI(path)}:${line}`,
    cliArgs: (path, line) => ['--goto', `${path}:${line}`]
  },
  {
    id: 'zed',
    label: 'Zed',
    appBundle: 'Zed.app',
    bin: 'zed',
    url: (path, line) => `zed://file${encodeURI(path)}:${line}`,
    cliArgs: (path, line) => [`${path}:${line}`]
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    appBundle: 'Sublime Text.app',
    windowsPath: 'Sublime Text\\sublime_text.exe',
    bin: 'subl',
    // Sublime's scheme wants the path as a query parameter, not a path segment.
    url: (path, line) => `subl://open?url=file://${encodeURIComponent(path)}&line=${line}`,
    cliArgs: (path, line) => [`${path}:${line}`]
  },
  {
    id: 'jetbrains',
    label: 'JetBrains IDE',
    bin: process.platform === 'win32' ? 'idea64.exe' : 'idea',
    cliArgs: (path, line) => ['--line', String(line), path]
  }
]

/** What an editor turned out to support on this machine. */
interface DetectedEditor extends EditorInfo {
  definition: EditorDefinition
  /** Absolute path to the CLI, when one was found on PATH. */
  binPath: string | null
  hasApplication: boolean
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Look a command up on PATH, the same way a shell would. */
async function findOnPath(bin: string): Promise<string | null> {
  const path = process.env.PATH
  if (!path) return null
  // Windows executables need their extension; PATHEXT lists which count.
  const suffixes =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((value) => value.toLowerCase())
      : ['']
  for (const directory of path.split(delimiter)) {
    if (!directory) continue
    for (const suffix of suffixes) {
      const candidate = join(directory, bin.endsWith(suffix) ? bin : bin + suffix)
      if (await exists(candidate)) return candidate
    }
  }
  return null
}

async function hasApplication(definition: EditorDefinition): Promise<boolean> {
  if (process.platform === 'darwin' && definition.appBundle) {
    return (
      (await exists(join('/Applications', definition.appBundle))) ||
      (await exists(join(homedir(), 'Applications', definition.appBundle)))
    )
  }
  if (process.platform === 'win32' && definition.windowsPath) {
    const roots = [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : null,
      process.env.ProgramFiles ?? null,
      process.env['ProgramFiles(x86)'] ?? null
    ].filter((root): root is string => root !== null)
    for (const root of roots) {
      if (await exists(join(root, definition.windowsPath))) return true
    }
  }
  return false
}

/**
 * Detection is cached for the life of the process. Installing an editor while
 * GitWarren is open is rare enough to be worth a restart, and the alternative
 * is a dozen filesystem probes every time a diff renders.
 */
let cache: Promise<DetectedEditor[]> | null = null

function detect(): Promise<DetectedEditor[]> {
  cache ??= Promise.all(
    EDITORS.map(async (definition) => {
      const [binPath, application] = await Promise.all([
        definition.bin ? findOnPath(definition.bin) : Promise.resolve(null),
        hasApplication(definition)
      ])
      return {
        id: definition.id,
        label: definition.label,
        definition,
        binPath,
        hasApplication: application
      }
    })
  ).then((found) => found.filter((editor) => editor.binPath !== null || editor.hasApplication))

  return cache
}

/** The command template form of `GITWARREN_EDITOR`, if that is what it holds. */
function customCommand(): { bin: string; args: string[] } | null {
  const value = process.env.GITWARREN_EDITOR?.trim()
  if (!value) return null
  if (EDITORS.some((editor) => editor.id === value)) return null
  const [bin, ...args] = value.split(/\s+/)
  return bin ? { bin, args } : null
}

/**
 * Every editor this machine can open a file with, plus which one is used when
 * the caller does not name one.
 */
export async function listEditors(): Promise<{ editors: EditorInfo[]; defaultId: string | null }> {
  const custom = customCommand()
  const detected = await detect()
  const editors = detected.map(({ id, label }) => ({ id, label }))

  if (custom) {
    // Named first so the UI can show what the environment asked for, and made
    // the default because an explicit setting outranks a guess.
    const entry = { id: 'custom', label: `${custom.bin} (GITWARREN_EDITOR)` }
    return { editors: [entry, ...editors], defaultId: 'custom' }
  }

  const preferred = process.env.GITWARREN_EDITOR?.trim()
  const defaultId =
    (preferred && editors.some((editor) => editor.id === preferred) ? preferred : null) ??
    editors[0]?.id ??
    null

  return { editors, defaultId }
}

function launchCommand(bin: string, args: string[]): void {
  // Detached and unref'd: the editor outlives GitWarren, and its stdio must not
  // keep this process's event loop alive.
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

/**
 * Open `path` at `line` in an editor.
 *
 * Falls back to the platform's default handler for the file when no editor was
 * detected, which is usually still the right application - just without the
 * line number.
 */
export async function openInEditor(path: string, line: number, editorId?: string): Promise<void> {
  const custom = customCommand()
  if (custom && (editorId === undefined || editorId === 'custom')) {
    const args = custom.args.map((argument) =>
      argument.replace('{file}', path).replace('{line}', String(line))
    )
    // A template with no {file} still has to be told what to open.
    launchCommand(custom.bin, args.some((argument) => argument.includes(path)) ? args : [...args, path])
    return
  }

  const detected = await detect()
  const chosen =
    (editorId ? detected.find((editor) => editor.id === editorId) : undefined) ?? detected[0]

  if (!chosen) {
    const failure = await shell.openPath(path)
    if (failure) throw new AppError('PATH_NOT_FOUND', failure)
    return
  }

  if (chosen.hasApplication && chosen.definition.url) {
    try {
      await shell.openExternal(chosen.definition.url(path, line))
      return
    } catch {
      // The scheme is not registered after all; the CLI below still might be.
    }
  }

  if (chosen.binPath && chosen.definition.cliArgs) {
    launchCommand(chosen.binPath, chosen.definition.cliArgs(path, line))
    return
  }

  const failure = await shell.openPath(path)
  if (failure) throw new AppError('PATH_NOT_FOUND', failure)
}
