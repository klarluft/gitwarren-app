/**
 * What every carrier is, and the few things all of them need.
 *
 * M4 had one way of reaching another machine, so the contract lived in
 * `ssh.ts` alongside the only implementation of it. M5 adds `wsl.ts`, and this
 * file is the part that stopped belonging to either - the same move `ndjson.ts`
 * made at M4 for the same reason, one layer up. A shape that is written down
 * twice is a shape the two copies eventually disagree about, and here the
 * disagreement would be silent: the pool holds carriers through this interface
 * and would go on compiling while one of them quietly stopped waiting for an
 * exit before explaining itself.
 *
 * What is deliberately *not* here is anything about how a connection is made.
 * `ssh` has options, a multiplexing master and an authentication story;
 * `wsl.exe` has none of those and has two encodings and a stream it writes its
 * own errors onto. Those are the carriers' own business, and the whole point of
 * the interface is that the pool never learns which one it is holding.
 */
import { AppError } from '../../shared/errors.js'
import { DAEMON_READY_PREFIX } from '../../shared/rpc.js'
import type { RpcMethod, RpcParams, RpcResult } from '../../shared/rpc.js'

/**
 * The launcher M2 promised would stay put.
 *
 * `~` rather than an absolute path, expanded by a shell on the far end, because
 * the machine holding the question has no idea what home is on the machine
 * holding the answer. Both carriers spawn this, and the indirection is what lets
 * an upgrade replace what it resolves to without rewriting an agent's config -
 * see `src/cli/launchers.ts`.
 */
export const REMOTE_LAUNCHER = '~/.gitwarren/bin/gitwarren'

/**
 * How much of a host's stderr to keep.
 *
 * A far end says why it failed and then exits, so by the time anyone can ask,
 * the only evidence is what was captured while it ran. Bounded because a daemon
 * in a crash loop can produce a great deal of it, and this is held in memory for
 * the lifetime of a connection.
 */
export const MAX_STDERR_BYTES = 8 * 1024

/**
 * How long to wait for the child to exit before giving up on a better
 * explanation.
 *
 * See `diagnostics` below. The wait only ever happens on a connection that has
 * already failed, and both `ssh` and `wsl.exe` exit within milliseconds of
 * closing their streams, so this bounds a pathological case rather than being a
 * delay anyone waits for.
 */
export const EXIT_GRACE_MS = 500

export interface HostConnection {
  request<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>>
  close(): void
  isOpen(): boolean
  /**
   * The best available explanation of why this connection is no longer working.
   *
   * A promise, and that is the whole point of it. The protocol notices a dead
   * connection when the far end's *stdout* ends, which happens a moment before
   * the `exit` that carries the status code and after which stderr is complete.
   * Reading the reason synchronously at the instant a request fails therefore
   * gets "the connection closed" - true, useless, and the message a person
   * would otherwise see for a hostname that does not resolve.
   *
   * So this waits for the exit that is already on its way, briefly, and answers
   * with what the system actually said. Found in M4.1 against a real machine,
   * and it is the reason this is in the interface rather than a field.
   */
  diagnostics(): Promise<string>
}

/** What one command on a host came to. Never a throw for a non-zero exit. */
export interface HostRunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Methods this install answers for itself, whatever host is being looked at.
 *
 * A host's list of hosts is its own business. Forwarding these would make host
 * A's list readable - and removable - from host B, and turn a hub and its
 * spokes into a mesh nobody asked for. `core/hosts/router.ts` is where the
 * general local-versus-remote decision is made; this is the backstop that makes
 * the rule structural rather than a comment, and every carrier checks it because
 * a carrier is the last thing a request passes before it leaves the machine.
 *
 * A prefix rather than a list of names, so that adding `hosts.rename` tomorrow
 * cannot accidentally become forwardable. M5 relies on that: `hosts.distros`
 * became unforwardable by being named, which is the right amount of work for a
 * question that is about the machine holding the list.
 */
export function isLocalOnly(method: string): boolean {
  return method.startsWith('hosts.')
}

/**
 * The last few lines a failing host said, minus the one line that cannot be a
 * reason.
 *
 * Two different kinds of line arrive on stderr and only one of them is an
 * explanation. A daemon that started announces itself there - M4.1 put the
 * banner on stderr precisely so it could not hurt the framing on stdout - and
 * quoting it back at somebody whose connection has just died reads as though it
 * were the cause: "The connection to xfor@pc-wsl was terminated (SIGKILL).
 * [gitwarren-serve] ready (instance …)". Proof of a healthy start is the one
 * thing that cannot be why it stopped. Every other line is kept, because any of
 * them might be.
 */
export function diagnosticTail(stderr: string, lines = 3): string {
  return stderr
    .trim()
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(DAEMON_READY_PREFIX))
    .slice(-lines)
    .join(' ')
    .trim()
}

/** Every carrier reports an unreachable machine the same way. */
export function offline(message: string): AppError {
  return new AppError('HOST_OFFLINE', message)
}
