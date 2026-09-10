/**
 * `out/daemon/serve.cjs` - the daemon as a process.
 *
 * Argv, signals and the exit code, and not one line more. Everything the daemon
 * actually does is in `daemon.ts`, which `main/index.ts` imports too so that
 * `GitWarren --serve` is the same daemon rather than a second implementation of
 * it. Keeping the two apart is what lets that import happen without this file's
 * `process.exit` firing inside the Electron main process.
 */
import { runDaemon } from './daemon.js'
import { shutdownListen } from './listen.js'

/**
 * `shutdownListen` covers the stdio carrier too: it closes the database and is
 * a no-op about everything the listening mode claimed when that mode never ran.
 * One exit path rather than two, so a signal cannot leave a runtime file or a
 * token behind depending on which flag the process was started with.
 */
function shutdown(): void {
  shutdownListen()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// 2 rather than 1: this is "you asked for something that is not a carrier",
// which a caller can act on, not "the daemon fell over". A mode that refused
// for a reason of its own has already said which by setting `exitCode`, and
// that answer is more specific than this one.
if (!runDaemon(process.argv.slice(2))) process.exit(process.exitCode === undefined ? 2 : 1)
