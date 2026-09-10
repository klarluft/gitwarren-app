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
 * Plain JS only. No Node, no Electron.
 */
import type { EditorInfo } from './api.js'

export interface EditorLink extends EditorInfo {
  /**
   * The URL that opens `path` at `line`, or absent when the editor has no
   * scheme worth using and can only be launched from a command line.
   */
  url?: (path: string, line: number) => string
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
    url: (path, line) => `vscode://file${encodeURI(path)}:${line}`
  },
  {
    id: 'cursor',
    label: 'Cursor',
    url: (path, line) => `cursor://file${encodeURI(path)}:${line}`
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    url: (path, line) => `windsurf://file${encodeURI(path)}:${line}`
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
