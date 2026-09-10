/**
 * Reading a directory, so that a machine without a window can still be browsed.
 *
 * This is the one piece of the core that exists because of a *capability*
 * rather than because of a domain. `capabilities.pickDirectory` is false in a
 * browser tab, and it is meaningless on a remote host - a native picker there
 * would browse the wrong machine, which is the comment
 * `repository-form-dialog.tsx` has been carrying since M3. So the picker's job
 * is split in two: opening a window stays in the shell where it always was, and
 * "what is inside this folder" becomes a method, answered by whoever owns the
 * folder.
 *
 * That is also why this is not `dialog.showOpenDialog` behind an interface. A
 * dialog returns a path and nothing else; a method has to return enough for the
 * *asking* machine to draw a picker for a filesystem it cannot see - which
 * means the separator, where home is, and which of these folders is a
 * repository.
 *
 * ## Directories only
 *
 * A file is never the answer to "which repository is this?", and a source tree
 * has a hundred files per folder. Listing them would make every response an
 * order of magnitude bigger, over a connection that in M4 is an `ssh` pipe, for
 * rows a person cannot click.
 *
 * Hidden entries *are* listed, and the decision about whether to show them is
 * left to the screen. Dotfile repositories are a real thing people review, so
 * this cannot filter them out; and a listing that silently omitted rows would
 * be a listing you could not trust when the folder you wanted was not in it.
 *
 * ## What it will not do
 *
 * There is no root to escape from and no traversal check, and that is
 * deliberate rather than an oversight. `repositories.add` already takes any
 * absolute path on the host and reads git there; a caller who can reach the
 * dispatcher can already name any directory on the machine. Pretending this one
 * method has a sandbox would be security theatre over a door that is open next
 * to it - the real boundary is who may reach the dispatcher at all, which is
 * `core/web/token.ts` for a tab and the person's own SSH keys for a host.
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { AppError } from '../../shared/errors.js'
import { parseWithSchema as parse } from '../../shared/validation.js'
import { listDirectoryInputSchema, type DirectoryListing } from '../../shared/schemas.js'

/**
 * How many subdirectories to send back.
 *
 * `node_modules` is the case this exists for: a folder with two thousand
 * entries in it is not a folder anybody is going to find a repository in by
 * scrolling, and the whole listing has to cross an `ssh` pipe first. The screen
 * says the list was cut short, so the remaining half of the interaction - the
 * text field - is still there for someone who knows the path.
 */
export const MAX_ENTRIES = 500

/**
 * Expand a leading `~`, and only a leading one.
 *
 * The remote case is why this is here at all: a person adding a repository on
 * `pc-wsl` from a Mac knows it is under `~/github.com`, and has no particular
 * reason to know that `~` is `/home/xfor` over there. Expanded by whoever
 * answers, because that is the only machine that knows.
 *
 * `~user` is deliberately not expanded. It would mean reading the password
 * database to answer, and a path that begins `~someone` is very much more
 * likely to be a directory that is literally called that.
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Is this directory a git repository root?
 *
 * A `.git` entry, of either shape: a directory in an ordinary clone, a file in
 * a linked worktree or a submodule. Deliberately not `git rev-parse` - that
 * would be a process per row, and this answer only decides whether to draw a
 * badge next to a folder name.
 */
async function looksLikeRepository(path: string): Promise<boolean> {
  try {
    await stat(join(path, '.git'))
    return true
  } catch {
    return false
  }
}

/** The parent of a path, or null once there is nothing above it. */
function parentOf(path: string): string | null {
  const parent = resolve(path, '..')
  return parent === path ? null : parent
}

/**
 * List the directories inside one directory.
 *
 * A missing or unreadable path is an `AppError` rather than an empty listing,
 * because the two are different answers to the person typing: one means "that
 * folder is not there" and the other means "it is there and it is empty".
 */
async function listDirectory(input: unknown): Promise<DirectoryListing> {
  const { path } = parse(listDirectoryInputSchema, input)

  const requested = path === undefined || path.trim() === '' ? homedir() : expandHome(path.trim())
  if (!isAbsolute(requested)) {
    throw new AppError('INVALID_INPUT', `Not an absolute path: ${requested}`, {
      path: ['Enter a path that starts at the root of the filesystem.']
    })
  }

  // Resolved rather than used as typed, so that `..` in a hand-typed path and
  // the parent link below both produce the same string for the same folder -
  // which is what lets the screen tell whether it has moved.
  const directory = resolve(requested)

  let names: string[]
  try {
    const found = await readdir(directory, { withFileTypes: true })
    names = found
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch (error) {
    throw asBrowseError(error, directory)
  }

  const truncated = names.length > MAX_ENTRIES
  const shown = truncated ? names.slice(0, MAX_ENTRIES) : names

  const entries = await Promise.all(
    shown.map(async (name) => {
      const full = join(directory, name)
      return {
        name,
        path: full,
        // A symlink that points at a file, or at nothing, is filtered out here
        // rather than above: `readdir` reports the link, and only a `stat`
        // knows what is on the other end of it.
        isDirectory: await isDirectory(full),
        isRepository: await looksLikeRepository(full),
        isHidden: name.startsWith('.')
      }
    })
  )

  return {
    path: directory,
    parent: parentOf(directory),
    home: homedir(),
    separator: sep,
    entries: entries.filter((entry) => entry.isDirectory).map(({ isDirectory: _, ...rest }) => rest),
    truncated
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Turn a filesystem errno into something worth showing.
 *
 * The two that actually happen are worth separating: a path that is not there
 * is usually a typo, and a path that is there and refused is usually somebody
 * else's home directory. Everything else keeps its own message, which for a
 * filesystem error is generally more use than any sentence written here.
 */
function asBrowseError(error: unknown, path: string): AppError {
  const code = (error as { code?: string } | null)?.code
  if (code === 'ENOENT') {
    return new AppError('PATH_NOT_FOUND', `No such folder: ${path}`, {
      path: ['That folder does not exist.']
    })
  }
  if (code === 'ENOTDIR') {
    return new AppError('INVALID_INPUT', `Not a folder: ${path}`, {
      path: ['That is a file, not a folder.']
    })
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new AppError('FORBIDDEN', `Not allowed to read ${path}.`, {
      path: ['GitWarren is not allowed to read that folder.']
    })
  }
  return AppError.from(error)
}

/**
 * The service, so that the dispatcher's map stays a table of one-line
 * delegations and every method reads the same way.
 */
export const fsService = {
  list: listDirectory
}
