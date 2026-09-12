/**
 * Hand a URL to the desktop's browser.
 *
 * Two commands need this and neither should own it: `gitwarren open` is the
 * one it was written for, and `gitwarren serve --open` hands over the URL it
 * has just printed. One implementation, because the rules below are the kind
 * that are easy to get right once and easy to lose in a copy.
 *
 * `execFile`, never a shell: the URL carries a token and a fragment, and the
 * one thing that must not happen to a string like that is word splitting by
 * something that also understands `;`. Windows is the exception in shape rather
 * than in rule - `start` is a `cmd` builtin and cannot be executed directly -
 * and its empty `""` is the window *title*, which has to be there or `cmd`
 * reads the quoted URL as one.
 *
 * Detached and unreferenced, because `open` and `xdg-open` on some desktops do
 * not return until the browser they started exits, and the caller has nothing
 * left to say once the URL is handed over.
 *
 * Failure is reported through `onError` rather than thrown: the browser
 * launcher answers later, from a callback, and by then the command that asked
 * may be a server that must not die because `xdg-open` is missing on a VPS.
 */
import { execFile } from 'node:child_process'

export function openInBrowser(url: string, onError: (message: string) => void): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]

  const child = execFile(command, args, { windowsHide: true }, (error) => {
    if (error) onError(`could not ask ${command} to open a browser (${error.message})`)
  })
  child.unref()
}
