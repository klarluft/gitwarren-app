/**
 * `out/daemon/gitwarren.cjs` - the CLI as a process.
 *
 * Argv, signals and the exit code, and not one line more. This is the file that
 * was `daemon/serve.ts` until M3.3, promoted rather than duplicated: the daemon
 * grew two commands that are not carriers, so the process entry moved up to the
 * layer that has all three and `daemon/daemon.ts` went back to being only the
 * daemon. There is still exactly one non-Electron bundle, and `main/index.ts`
 * still imports `runDaemon` from source, so `GitWarren --serve` is the same
 * daemon rather than a second implementation of it. Keeping the entry apart
 * from `runDaemon` is what lets that import happen without this file's
 * `process.exit` firing inside the Electron main process.
 */
import { runCli } from './router.js'
import { shutdownListen } from '../daemon/listen.js'

/**
 * `shutdownListen` covers every command, not only the listening one: it closes
 * the database and is a no-op about everything that mode claimed when that mode
 * never ran. One exit path rather than one per command, so a signal cannot
 * leave a runtime file or a token behind depending on which words were typed.
 */
function shutdown(): void {
  shutdownListen()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// 2 rather than 1: this is "you asked for something that is not a command",
// which a caller can act on, not "gitwarren fell over". A command that refused
// for a reason of its own has already said which by setting `exitCode`, and
// that answer is more specific than this one.
if (!runCli(process.argv.slice(2))) process.exit(process.exitCode === undefined ? 2 : 1)
