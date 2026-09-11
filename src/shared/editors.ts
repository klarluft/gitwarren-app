/**
 * The editors GitWarren knows how to point at a line, and the URL each one
 * registered for itself.
 *
 * Two shells launch editors and they do it by different means, which is exactly
 * why the *forms* live in one place. The Electron app detects what is installed
 * and can fall back to a CLI on PATH; a browser tab can do neither - it cannot
 * look at the filesystem and it cannot spawn a process, and it must not ask a
 * server to spawn one either (see the note at the top of `core/rpc/
 * dispatcher.ts`). What a tab *can* do is navigate to a URL scheme, which the
 * operating system hands to the application that claimed it. So the tab offers
 * this list as a choice rather than as a detection, and the same string that
 * `main/editors.ts` would have opened is the one the browser opens.
 *
 * Detection lives in `main/editors.ts` and stays there: application bundles,
 * `PATH` lookups and `cliArgs` are Node's business. This file is the half both
 * shells need, and it is the half a browser bundle can import.
 *
 * ## Files on another machine
 *
 * M4.4 adds a second URL per editor, for a file that is not on this computer:
 * `vscode://vscode-remote/ssh-remote+xfor@pc-wsl/home/xfor/…:42`. It is a
 * different URL rather than the same one with a prefix, and only three of the
 * six editors below have one - which is the useful half of putting it here,
 * because "can this editor even do that" becomes a question the picker can ask
 * before it offers a button. See spike S4 in docs/across-hosts.md for what was
 * verified and on which machines.
 *
 * Plain JS only. No Node, no Electron.
 */
import type { EditorInfo } from './api.js'

export interface EditorLink extends EditorInfo {
  /**
   * The URL that opens `path` at `line`, or absent when the editor has no
   * scheme worth using and can only be launched from a command line.
   */
  url?: (path: string, line: number) => string
  /**
   * The same, for a file on another machine - `remote` being the authority that
   * editor's own remote extension knows the machine by, such as
   * `ssh-remote+xfor@pc-wsl` or `wsl+Ubuntu`. Absent when the editor has no way
   * to open a file it cannot see, which is most of them.
   *
   * A separate function rather than an optional argument to `url`, because the
   * two produce different URLs rather than the same URL with something extra
   * on it, and because "this editor cannot do that" has to be a thing a caller
   * can ask. An editor with no `remoteUrl` is left out of the picker on a remote
   * review entirely - the M4.3 rule about a control that would do something
   * plausible to the wrong machine, applied one level down.
   */
  remoteUrl?: (remote: string, path: string, line: number) => string
}

/**
 * How an editor on this machine names a file on another one.
 *
 * The stored `editor_target` wins when there is one, and NULL means derive it -
 * which is the common case and the reason the column is nullable rather than
 * filled in at Add time with a guess nobody has checked.
 *
 * M4.4 wrote down that the derivation would stop being one rule at M5, and this
 * is it: the two authorities are `ssh-remote+xfor@pc-wsl` and `wsl+Ubuntu`, and
 * they are different enough that a prefix swap is the whole of the difference.
 * That is exactly why `editor_target` is kept apart from `target` - the carrier
 * and the editor name the same machine in two vocabularies, and only one of them
 * is `ssh`'s. VS Code's remote authorities are the source: `ssh-remote+` comes
 * from ms-vscode-remote.remote-ssh and `wsl+` from ms-vscode-remote.remote-wsl,
 * and a link is inert without the matching extension - which is silent, and
 * caught M4.4 out on the Mac.
 *
 * Here rather than in the hosts service because both shells need it and only
 * one of them can read a database: a browser tab opens the same URLs and works
 * out the same authority from the host row it already has.
 */
export function editorTargetFor(host: {
  kind: string
  target: string
  editorTarget: string | null
}): string {
  if (host.editorTarget !== null) return host.editorTarget
  return host.kind === 'wsl' ? `wsl+${host.target}` : `ssh-remote+${host.target}`
}

/**
 * Order is the order a picker offers them in, and the first one is what a shell
 * with nothing better to go on will use. It is a judgement call rather than a
 * fact; the picker exists so the judgement does not have to be right.
 */
export const EDITOR_LINKS = [
  {
    id: 'vscode',
    label: 'VS Code',
    url: (path, line) => `vscode://file${encodeURI(path)}:${line}`,
    remoteUrl: (remote, path, line) =>
      `vscode://vscode-remote/${encodeURI(remote)}${encodeURI(path)}:${line}`
  },
  {
    id: 'cursor',
    label: 'Cursor',
    url: (path, line) => `cursor://file${encodeURI(path)}:${line}`,
    remoteUrl: (remote, path, line) =>
      `cursor://vscode-remote/${encodeURI(remote)}${encodeURI(path)}:${line}`
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    url: (path, line) => `windsurf://file${encodeURI(path)}:${line}`,
    remoteUrl: (remote, path, line) =>
      `windsurf://vscode-remote/${encodeURI(remote)}${encodeURI(path)}:${line}`
  },
  {
    id: 'zed',
    label: 'Zed',
    url: (path, line) => `zed://file${encodeURI(path)}:${line}`
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    // Sublime's scheme wants the path as a query parameter, not a path segment.
    url: (path, line) => `subl://open?url=file://${encodeURIComponent(path)}&line=${line}`
  },
  {
    id: 'jetbrains',
    label: 'JetBrains IDE'
  }
] as const satisfies readonly EditorLink[]

/**
 * The ids, as a union rather than as `string`.
 *
 * `main/editors.ts` keys its detection table by this, so an editor added here
 * without detection - or a key misspelled there - is a type error rather than
 * an editor that quietly stops being found on disk. That is the one failure the
 * split into two tables makes possible, so it is the one the types close.
 */
export type EditorId = (typeof EDITOR_LINKS)[number]['id']

export function editorLink(id: string | undefined): EditorLink | undefined {
  return id === undefined ? undefined : EDITOR_LINKS.find((editor) => editor.id === id)
}

/**
 * The editors a shell with no way to look at the filesystem can offer.
 *
 * Everything with a URL scheme, which is every entry but the JetBrains IDEs -
 * those are launched by `idea --line`, and there is nothing for a browser to
 * navigate to. Offering an editor that turns out not to be installed costs the
 * user a dismissed "open with?" dialog, which is a better failure than a
 * missing entry for the editor they actually use.
 */
export function linkableEditors(): EditorInfo[] {
  // Widened to `EditorLink` first: the literal type of the table knows which
  // entries have a `url` and which do not, and the filter is exactly the
  // question that distinction cannot be asked as.
  return (EDITOR_LINKS as readonly EditorLink[])
    .filter((editor) => editor.url !== undefined)
    .map(({ id, label }) => ({ id, label }))
}

/**
 * Whether this editor can be pointed at a file on another machine at all.
 *
 * `custom` is true and is the one id here that is not in the table. It stands
 * for whatever `GITWARREN_EDITOR` holds, and the template gained `{host}` in
 * M4.4 precisely so that somebody with `emacsclient` or a wrapper script can
 * say what "over there" means for them. Whether it works is theirs to know;
 * offering it is the only way they can find out.
 */
export function opensRemotely(id: string): boolean {
  if (id === 'custom') return true
  return EDITOR_LINKS.some((editor) => editor.id === id && 'remoteUrl' in editor)
}

/**
 * The subset of an editor list that can open a file on another machine, and
 * which of them to use when the caller does not name one.
 *
 * The filtering is here rather than in either shell because the list being
 * filtered is *detection* - what this machine has installed, which only the
 * Electron shell can know - while whether an editor has a remote form is a
 * property of the editor and the same everywhere. An empty result is the honest
 * answer for a machine with only Zed on it, and is what makes the button
 * disappear rather than open the wrong file.
 */
export function remotelyOpenable(list: {
  editors: EditorInfo[]
  defaultId: string | null
}): { editors: EditorInfo[]; defaultId: string | null } {
  const editors = list.editors.filter((editor) => opensRemotely(editor.id))
  const defaultId =
    list.defaultId !== null && editors.some((editor) => editor.id === list.defaultId)
      ? list.defaultId
      : (editors[0]?.id ?? null)
  return { editors, defaultId }
}
