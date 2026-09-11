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
 *    The forms themselves live in `shared/editors.ts` since M3.2, because a
 *    browser tab opens the same URLs and cannot import this file.
 *  - **A CLI on PATH** (`code -g file:line`), for editors with no scheme worth
 *    using and for the `GITWARREN_EDITOR` escape hatch.
 *
 * `GITWARREN_EDITOR` overrides all of it: either the id of an editor below, or
 * a command template such as `emacsclient +{line} {file}`. It is read from the
 * environment rather than stored as a setting because this app has no settings
 * screen, and the people who need something other than the five editors below
 * are the same people who already keep `EDITOR` set. Since M4.4 the template
 * also takes `{host}`, for a file on another machine.
 *
 * ## The file may not be on this computer
 *
 * From M4.4 every launch takes an optional `remote` - the authority an editor's
 * own remote extension knows a machine by. It is not a variant of this module
 * but a property of every path through it: a URL form, a CLI form and a
 * template each have a remote spelling or no spelling at all, and the ones with
 * none must fail rather than fall back, because every fallback in here ends at
 * *this* machine's filesystem. Opening the Mac's `/home/xfor/…` - which either
 * does not exist or is somebody else's file - is the exact failure M4.3 hid the
 * button to avoid.
 */
import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { shell } from 'electron'
import { EDITOR_LINKS, type EditorId, type EditorLink } from '../shared/editors.js'
import { AppError } from '../shared/errors.js'
import type { EditorInfo } from '../shared/api.js'

interface EditorDefinition extends EditorLink {
  /** macOS application bundle, looked for in the usual two places. */
  appBundle?: string
  /** Windows application path, relative to a well-known root. */
  windowsPath?: string
  /** Command to look for on PATH. */
  bin?: string
  /** Fallback launch: arguments for `bin`. */
  cliArgs?: (path: string, line: number) => string[]
  /**
   * The same, for a file on another machine. Absent when the CLI has no way to
   * say "over there", which is every editor that has no `remoteUrl` either.
   *
   * S4 found this form honours the line where the shim *inside* the remote
   * machine could not be spawned at all, so it is the fallback that actually
   * works rather than the one the plan assumed.
   */
  remoteCliArgs?: (remote: string, path: string, line: number) => string[]
}

/**
 * How to find each editor on this machine, keyed by the id it has in
 * `shared/editors.ts`.
 *
 * The ids, the labels and the URL forms live there because a browser tab in
 * M3.2 offers the same editors and opens the same URLs, with no way to look at
 * a filesystem. What is left here is everything Node can do and a tab cannot,
 * and the two halves are merged below - so an editor is added by adding it in
 * one place, and gains detection here only if there is detection to be had.
 */
const DETECTION: Record<EditorId, Omit<EditorDefinition, 'id' | 'label' | 'url'>> = {
  vscode: {
    appBundle: 'Visual Studio Code.app',
    windowsPath: 'Microsoft VS Code\\Code.exe',
    bin: 'code',
    cliArgs: (path, line) => ['--goto', `${path}:${line}`],
    remoteCliArgs: (remote, path, line) => ['--remote', remote, '--goto', `${path}:${line}`]
  },
  cursor: {
    appBundle: 'Cursor.app',
    windowsPath: 'cursor\\Cursor.exe',
    bin: 'cursor',
    cliArgs: (path, line) => ['--goto', `${path}:${line}`],
    remoteCliArgs: (remote, path, line) => ['--remote', remote, '--goto', `${path}:${line}`]
  },
  windsurf: {
    appBundle: 'Windsurf.app',
    bin: 'windsurf',
    cliArgs: (path, line) => ['--goto', `${path}:${line}`],
    remoteCliArgs: (remote, path, line) => ['--remote', remote, '--goto', `${path}:${line}`]
  },
  zed: {
    appBundle: 'Zed.app',
    bin: 'zed',
    cliArgs: (path, line) => [`${path}:${line}`]
  },
  sublime: {
    appBundle: 'Sublime Text.app',
    windowsPath: 'Sublime Text\\sublime_text.exe',
    bin: 'subl',
    cliArgs: (path, line) => [`${path}:${line}`]
  },
  jetbrains: {
    bin: process.platform === 'win32' ? 'idea64.exe' : 'idea',
    cliArgs: (path, line) => ['--line', String(line), path]
  }
}

/**
 * Order is the order the UI offers them in, and the first one found is the
 * default - both inherited from `EDITOR_LINKS`, so the two shells offer the
 * same editors in the same order.
 */
const EDITORS: EditorDefinition[] = EDITOR_LINKS.map((link) => ({
  ...link,
  ...DETECTION[link.id]
}))

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
 * `remote` is how this machine's editors name the machine the path is on -
 * `ssh-remote+xfor@pc-wsl`, per `editorTargetFor` - and absent means the path
 * is on this one. That argument is the whole of M4.4's editor work, and the
 * shape it forces is the interesting part: *every* fallback below has to be
 * asked whether it can say "over there", because the fallbacks are where a
 * remote path would otherwise quietly become a local one.
 *
 * Falls back to the platform's default handler for a local file when no editor
 * was detected, which is usually still the right application - just without the
 * line number. There is deliberately no such fallback for a remote file:
 * `shell.openPath` would hand this machine's Finder a path only WSL has, which
 * is the "something plausible to the wrong machine" M4.3 switched the whole
 * control off to avoid. It raises instead, and the sentence names the editor
 * and the machine.
 */
export async function openInEditor(
  path: string,
  line: number,
  editorId?: string,
  remote?: string
): Promise<void> {
  const custom = customCommand()
  if (custom && (editorId === undefined || editorId === 'custom')) {
    const args = custom.args
      .map((argument) =>
        argument
          .replace('{file}', path)
          .replace('{line}', String(line))
          .replace('{host}', remote ?? '')
      )
      // An argument that became empty is dropped, which is what makes one
      // template serve both cases: `--remote={host}` disappears on a local file
      // instead of being passed as a flag with nothing after it. Written as one
      // argument rather than two for exactly that reason - a `--remote {host}`
      // pair would leave the flag behind when the value vanished.
      .filter((argument) => argument.length > 0)
    // A template with no {file} still has to be told what to open.
    launchCommand(
      custom.bin,
      args.some((argument) => argument.includes(path)) ? args : [...args, path]
    )
    return
  }

  const detected = await detect()
  const chosen =
    (editorId ? detected.find((editor) => editor.id === editorId) : undefined) ?? detected[0]

  if (!chosen) {
    if (remote !== undefined) {
      throw new AppError(
        'INVALID_INPUT',
        `No editor on this machine can open a file on ${remote}. VS Code, Cursor or Windsurf ` +
          'with their remote extension can; GITWARREN_EDITOR with {host} in it can too.'
      )
    }
    const failure = await shell.openPath(path)
    if (failure) throw new AppError('PATH_NOT_FOUND', failure)
    return
  }

  const { definition } = chosen
  const url = remote === undefined ? definition.url?.(path, line) : definition.remoteUrl?.(remote, path, line)

  if (chosen.hasApplication && url) {
    try {
      await shell.openExternal(url)
      return
    } catch {
      // The scheme is not registered after all; the CLI below still might be.
    }
  }

  const cliArgs =
    remote === undefined
      ? definition.cliArgs?.(path, line)
      : definition.remoteCliArgs?.(remote, path, line)

  if (chosen.binPath && cliArgs) {
    launchCommand(chosen.binPath, cliArgs)
    return
  }

  if (remote !== undefined) {
    // Nothing left to try, and the local fallback is not a fallback here - it
    // opens a different file, or none, on a different computer.
    throw new AppError(
      'INVALID_INPUT',
      `${chosen.label} cannot open a file on ${remote} from this machine.`
    )
  }

  const failure = await shell.openPath(path)
  if (failure) throw new AppError('PATH_NOT_FOUND', failure)
}
