/**
 * The daemon: the core, with a pipe instead of a window.
 *
 * Its entry point is `serve.ts` next door, which is the file that becomes
 * `out/daemon/serve.cjs`. The split is so that `GitWarren --serve` can import
 * `runDaemon` without a module that parses argv and calls `process.exit` on
 * import running inside the Electron main process.
 *
 * `serve.cjs` is what a GitWarren on another machine will spawn - over `ssh` in
 * M4, over `wsl.exe` in M5 - and what `gitwarren serve` will be in M3. It runs
 * on a box with no display, no Electron and, thanks to the tarball from spike
 * S3, no Node installation either.
 *
 * There is deliberately very little here. Everything a caller can ask for is in
 * `core/rpc/dispatcher.ts` and everything about getting the question across the
 * pipe is in `core/rpc/stdio.ts`; this file chooses a carrier from argv, opens
 * the database, and stays out of the way. If it grows a feature, that feature
 * is in the wrong place - the GUI would not have it.
 *
 * One hard rule, borrowed from the MCP server for the same reason: **stdout
 * belongs to the protocol.** Diagnostics go to stderr. A stray `console.log`
 * here is a frame the peer cannot parse.
 *
 * ## It owns nothing
 *
 * A `--stdio` daemon deliberately does not write `daemon-runtime.json` and does
 * not check it. It binds no port, it answers one pipe, and it lives exactly as
 * long as the process that spawned it - so it is not a candidate for owning the
 * machine, and refusing to start next to a running GUI would be actively wrong:
 * that is the M4 case, where a GitWarren on the Mac spawns this on a PC that is
 * quite reasonably running its own GitWarren too.
 *
 * Ownership is about who holds the loopback port and answers links, which in M2
 * is the GUI and since M3 is also a *listening* `gitwarren serve`. That is
 * where the check belongs, and `listen.ts` next door is where it went: that
 * mode binds a port, claims the runtime file and refuses to start beside a
 * running app, none of which is true of the pipe this paragraph is about.
 */
import { closeDatabase, getDatabase } from '../core/db/client.js'
import { getInstanceId } from '../core/instance.js'
import { getDatabasePath } from '../core/paths.js'
import { serveStdio } from '../core/rpc/stdio.js'
import { RPC_PROTOCOL_VERSION } from '../shared/rpc.js'
import { runListen } from './listen.js'

const USAGE = `gitwarren serve --stdio
gitwarren serve --listen

--stdio answers GitWarren's message protocol on stdin and stdout, one JSON
object per line. Intended to be spawned by a GitWarren app over a pipe - by
hand it is a way to see what the protocol says:

  echo '{"id":1,"method":"repositories.list"}' | gitwarren serve --stdio

--listen serves the web view on loopback and prints a URL carrying this
launch's token. It claims this machine's data directory, so it refuses to
start while the app is running - see daemon/listen.ts.
`

/**
 * Start the daemon. Returns false when argv asked for something that is not a
 * carrier, so the caller can decide whether that is a usage error or a
 * different mode of its own - `main/index.ts` reuses this for `--serve`.
 */
export function runDaemon(argv: readonly string[]): boolean {
  // Checked before `--stdio` only because it is the mode that can *refuse*, and
  // its refusals are sentences rather than a usage block. The two are exclusive:
  // one binds a port and owns the machine, the other answers a pipe and owns
  // nothing.
  if (argv.includes('--listen')) return runListen()

  if (!argv.includes('--stdio')) {
    console.error(USAGE)
    return false
  }

  // Before the first frame is read, so that a peer's opening request does not
  // race the migrations. Failure here is fatal and must say so on stderr: a
  // daemon that answered `INTERNAL` to everything would look like a protocol
  // problem from the other end of an ssh pipe, which is the worst place to
  // start debugging a missing database.
  getDatabase()

  console.error(
    `[gitwarren-serve] ready (instance ${getInstanceId()}, protocol v${RPC_PROTOCOL_VERSION}, ` +
      `database: ${getDatabasePath()})`
  )

  serveStdio({
    input: process.stdin,
    output: process.stdout,
    // The parent closing the pipe is how a carrier says it is done with this
    // host - the app quitting, or an idle SSH connection being dropped in M4.
    // Nothing else is coming, so there is no reason to hold the database open.
    onEnd: () => {
      closeDatabase()
      process.exit(0)
    }
  })

  return true
}
