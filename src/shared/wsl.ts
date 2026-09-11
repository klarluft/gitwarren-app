/**
 * The two names one file inside a WSL distribution has.
 *
 * A repository in Ubuntu is `/home/xfor/github.com/klarluft/app` to everything
 * inside the distribution - git, the daemon, the agent, every path GitWarren
 * stores - and `\\wsl.localhost\Ubuntu\home\xfor\github.com\klarluft\app` to
 * Windows Explorer. M5 needs to translate in both directions, for two opposite
 * purposes:
 *
 * - **Towards Windows**, so that "Show in file manager" can work for a WSL host.
 *   M4.3 switched that control off for remote hosts because a path only the far
 *   machine has would open a window on nothing, and that reasoning is untouched:
 *   Windows-plus-WSL is the one arrangement where this machine genuinely *can*
 *   name that file, because the distribution is mounted here. The rule is not
 *   "WSL hosts are special", it is "reveal is offered when this machine can name
 *   the path in its own filesystem", and that is a question with one true answer
 *   per (shell, carrier) pair rather than an exception.
 *
 * - **Towards the distribution**, so that a `\\wsl.localhost\…` path typed into
 *   the *local* add-repository form can be refused with a pointer at the thing
 *   the person meant. See `core/git.ts`; what that guard prevents is not a
 *   cosmetic error but a repository whose git runs over SMB.
 *
 * Two prefixes are recognised. `\\wsl.localhost\` is current; `\\wsl$\` is the
 * older spelling, still resolves, and is what a person with a bookmark from a
 * few years ago has. Forward slashes are accepted for both because that is how
 * `git rev-parse --show-toplevel` hands the path back - `//wsl.localhost/Ubuntu/…`
 * - and a guard that only knew the backslash form would miss the value it is
 * most likely to be shown.
 *
 * Plain string functions, no Node: the renderer decides whether to draw a
 * button with these, and `core/` decides whether to refuse a path.
 */

/** The UNC prefixes Windows serves a distribution's filesystem under. */
export const WSL_UNC_PREFIXES = ['wsl.localhost', 'wsl$'] as const

/**
 * `('Ubuntu', '/home/xfor/app')` -> `\\wsl.localhost\Ubuntu\home\xfor\app`.
 *
 * Only ever called with a path the distribution itself supplied, so there is no
 * validation here: an absolute POSIX path is what every stored repository path
 * on a WSL host is, and a relative one would be a bug upstream rather than
 * something to sanitise at the last moment.
 */
export function windowsPathForWsl(distro: string, posixPath: string): string {
  const withoutLeadingSlash = posixPath.replace(/^\/+/, '')
  const windowsTail = withoutLeadingSlash.split('/').join('\\')
  return `\\\\wsl.localhost\\${distro}${windowsTail ? `\\${windowsTail}` : ''}`
}

/**
 * The distribution and POSIX path a `\\wsl.localhost\…` string names, or null.
 *
 * Null for everything that is not one of these, including an ordinary Windows
 * path and an ordinary POSIX one, so a caller can use it as the whole of its
 * test rather than pairing it with a `startsWith` that might disagree.
 *
 * A bare `\\wsl.localhost\Ubuntu` with nothing after it answers `/` - the root
 * of that distribution - which is a real place and the honest reading, rather
 * than an empty string a caller would have to special-case.
 */
export function wslPathFromWindows(path: string): { distro: string; path: string } | null {
  // Both separators, because git answers with forward slashes and Explorer with
  // backslashes, and the same string arrives from both.
  const normalised = path.split('\\').join('/')
  if (!normalised.startsWith('//')) return null

  const segments = normalised.slice(2).split('/')
  const server = segments[0]
  if (server === undefined) return null
  // Case-insensitively, because a UNC server name is, and `\\WSL.LOCALHOST\…`
  // is a perfectly ordinary thing for a path to have been through.
  if (!WSL_UNC_PREFIXES.some((prefix) => prefix === server.toLowerCase())) return null

  const distro = segments[1]
  if (distro === undefined || distro.length === 0) return null

  const rest = segments.slice(2).filter((segment) => segment.length > 0)
  return { distro, path: `/${rest.join('/')}` }
}
