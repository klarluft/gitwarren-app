/**
 * `gitwarren open` - the browser, at the right page, already signed in.
 *
 * The command exists because of one line in M3's loopback-security bullet: a
 * per-launch token printed by `gitwarren serve` and *carried* by
 * `gitwarren open`. A user who has to copy a 43-character token out of a
 * terminal will paste it wrong once and then leave the tab open for a week,
 * which is exactly the habit the per-launch token was chosen to avoid.
 *
 * So this reads the token from the file the serving process published at mode
 * 0600, and hands the whole URL to the operating system. The secret goes from
 * one file to one browser without passing through a human.
 *
 * ## It does not start anything
 *
 * A server that is not running is reported, not launched. Starting a daemon as
 * a side effect of "open" would leave a process behind that the user did not
 * ask for and has no obvious way to find - and there is already a right answer
 * for wanting one permanently, which is `gitwarren service install`. The
 * refusal names both.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readLiveDaemonRuntime } from '../core/daemon-runtime.js'
import { getWebTokenPath } from '../core/web/token.js'
import { webUrlFor } from './target.js'

const USAGE = `gitwarren open [link] [--print]

Opens this machine's GitWarren in a browser, carrying the running server's
token so the tab is authenticated without anything being copied.

  link     a gitwarren:// deep link or the http://127.0.0.1 URL an agent hands
           out. Without one, the repository list.
  --print  print the URL instead of opening it - for an ssh session, or for
           piping somewhere.
`

/**
 * Hand a URL to the desktop.
 *
 * `execFile`, never a shell: the URL carries a token and a fragment, and the
 * one thing that must not happen to a string like that is word splitting by
 * something that also understands `;`. Windows is the exception in shape rather
 * than in rule - `start` is a `cmd` builtin and cannot be executed directly -
 * and its empty `""` is the window *title*, which has to be there or `cmd`
 * reads the quoted URL as one.
 *
 * Detached and unreferenced, because `open` and `xdg-open` on some desktops do
 * not return until the browser they started exits, and this command has nothing
 * left to say once the URL is handed over.
 */
function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]

  const child = execFile(command, args, { windowsHide: true }, (error) => {
    if (error) {
      console.error(
        `[gitwarren] could not ask ${command} to open a browser (${error.message}). ` +
          `The URL is:\n\n    ${url}\n`
      )
      process.exitCode = 1
    }
  })
  child.unref()
}

export function runOpen(argv: readonly string[]): boolean {
  const print = argv.includes('--print')
  const rest = argv.filter((argument) => argument !== '--print')

  if (rest.length > 1 || rest.some((argument) => argument.startsWith('--'))) {
    console.error(USAGE)
    return false
  }

  const owner = readLiveDaemonRuntime()
  if (owner === null) {
    console.error(
      '[gitwarren] nothing is serving this machine. Start it with `gitwarren serve`, or ' +
        '`gitwarren service install` to have it start at login.'
    )
    process.exitCode = 1
    return true
  }

  // A live owner with no port bound: the app is up but something else holds
  // 41427, which `daemon-runtime.ts` records as `linkPort: null` rather than by
  // omitting the file. There is no URL to open, and saying which port is the
  // only useful thing left.
  if (owner.linkPort === null) {
    console.error(
      '[gitwarren] GitWarren is running but could not bind its loopback port, so there is ' +
        'no page to open. Something else on this machine holds it.'
    )
    process.exitCode = 1
    return true
  }

  let token: string
  try {
    token = readFileSync(getWebTokenPath(), 'utf8').trim()
  } catch {
    console.error(
      `[gitwarren] no session token at ${getWebTokenPath()}. The process serving this ` +
        'machine is older than its web view, or could not write the file. Restarting it ' +
        'mints a new one.'
    )
    process.exitCode = 1
    return true
  }

  const url = webUrlFor(owner.owner, token, rest[0])
  if (url === null) {
    console.error(`[gitwarren] "${rest[0]}" is not a GitWarren link.\n\n${USAGE}`)
    process.exitCode = 1
    return true
  }

  // stdout, unlike every other message in the CLI. `--print` exists to be piped
  // and substituted, and a URL on stderr is the one thing that would make it
  // useless for that.
  if (print) console.log(url)
  else openInBrowser(url)

  return true
}
