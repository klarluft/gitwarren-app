/**
 * `ssh`, as a way of starting a daemon and talking to it.
 *
 * The whole of M4's novelty, in one small file, because everything else was
 * already built to accept it: the protocol is `shared/rpc.ts`, the framing is
 * `core/rpc/ndjson.ts`, the asking side is `core/rpc/stdio-client.ts`, and what
 * answers on the far end is the same `gitwarren serve --stdio` the daemon has
 * run since M2. This module contributes a child process and an argument vector.
 *
 * ## The command, and why each part of it is there
 *
 *   ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPersist=10m \
 *       -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
 *       <target> ~/.gitwarren/bin/gitwarren serve --stdio
 *
 * `BatchMode=yes` is the one that turns a hang into an error. Without it `ssh`
 * will happily sit at a passphrase or a host-key prompt on a stdin that is
 * carrying JSON and no human, and the GUI waits forever with a spinner. With
 * it, an unauthenticated host fails in a second and the Hosts screen can say
 * what went wrong. Key management is the person's own, through their SSH agent
 * and config; GitWarren never asks for a password and has nowhere to keep one.
 *
 * `ControlMaster=auto` with `ControlPersist=10m` is what makes the *second*
 * connection cheap. The first pays a TCP handshake and a key exchange; every
 * one after it multiplexes onto the same channel, so a reconnect after a blip -
 * or a probe from the Hosts screen while a review is open - costs a process
 * spawn rather than a round of crypto.
 *
 * `ServerAliveInterval` is the half that makes a *dead* connection detectable.
 * A dropped network with no keepalive leaves `ssh` waiting on a socket the
 * kernel has no reason to give up on, which is the "content is stale and
 * nothing says so" failure M4.5 exists to prevent. Three misses at fifteen
 * seconds means a hung host is known within a minute.
 *
 * The remote command is the *launcher path*, not the versioned directory, for
 * the reason M2 established: agent configs and this carrier both point at
 * `~/.gitwarren/bin/gitwarren`, so an upgrade replaces what it resolves to and
 * nothing that referenced it has to be rewritten. `$HOME` is spelled `~` and
 * expanded by the remote shell, because the local process has no idea what the
 * remote home directory is.
 *
 * ## What this module refuses to do
 *
 * It does not authenticate (`ssh` did that before we saw a byte) and it does
 * not decide what any method means. Since M4.2 it owns one thing besides the
 * carrier - `runOverSsh`, a single command on a host - because "how this app
 * invokes ssh" is one decision and `SSH_OPTIONS` is where it is written down.
 * What that is *used* for is `core/hosts/install.ts`; the multiplexing master
 * is why `uname -sm` on a host with a connection open costs a process spawn
 * and nothing else.
 *
 * The one rule it enforces itself is that a `hosts.*` method is never sent. A
 * host list is a property of the install a person is sitting at: forwarding it
 * would make host A's list of hosts readable - and writable - from host B, and
 * turn a hub-and-spoke arrangement into a mesh nobody asked for. The routing
 * layer in M4.3 is what will decide local-versus-remote in general; this is the
 * backstop that makes the rule structural rather than a comment, and it lives
 * here because a carrier is the last thing a request passes before it leaves
 * the machine.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createStdioClient, type StdioClient } from '../rpc/stdio-client.js'
import { AppError } from '../../shared/errors.js'
import type { RpcMethod, RpcParams, RpcResult } from '../../shared/rpc.js'

/** The launcher M2 promised would stay put. */
export const REMOTE_LAUNCHER = '~/.gitwarren/bin/gitwarren'

/**
 * Options given to `ssh` on every connection.
 *
 * A list rather than a template so that a test can assert on it, and so that
 * the reasoning above has something to point at. Deliberately no `-T`: the
 * remote command makes this non-interactive already, and no `StrictHostKeyChecking`
 * override, because silently accepting an unknown host key is a decision that
 * belongs to the person, in their own SSH config, not to a review tool.
 */
export const SSH_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ControlMaster=auto',
  '-o',
  'ControlPersist=10m',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3'
] as const

export function sshArgs(target: string): string[] {
  return [...SSH_OPTIONS, target, REMOTE_LAUNCHER, 'serve', '--stdio']
}

/**
 * How much of the host's stderr to keep.
 *
 * `ssh` says why it failed on stderr and then exits, so by the time anyone can
 * ask, the only evidence is what was captured while it ran. Bounded because a
 * daemon in a crash loop can produce a great deal of it, and this is held in
 * memory for the lifetime of a connection.
 */
const MAX_STDERR_BYTES = 8 * 1024

/**
 * How long to wait for `ssh` to exit before giving up on a better explanation.
 *
 * See `diagnostics` below. The wait only ever happens on a connection that has
 * already failed, and `ssh` exits within milliseconds of closing its streams,
 * so this is a bound on a pathological case rather than a delay anyone waits
 * for in practice.
 */
const EXIT_GRACE_MS = 500

export interface SshConnection {
  request<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>>
  close(): void
  isOpen(): boolean
  /**
   * The best available explanation of why this connection is no longer working.
   *
   * A promise, and that is the whole point of it. The protocol notices a dead
   * connection when the far end's *stdout* ends, which for a failing `ssh`
   * happens a moment before the `exit` event that carries the status code and
   * after which stderr is complete. Reading the reason synchronously at the
   * instant a request fails therefore gets "the connection closed" - true,
   * useless, and the message a person would otherwise see for a hostname that
   * does not resolve.
   *
   * So this waits for the exit that is already on its way, briefly, and answers
   * with what `ssh` actually said.
   */
  diagnostics(): Promise<string>
}

export interface SpawnSshOptions {
  target: string
  /** Swappable so the tests can run a fake host without an `ssh` on the box. */
  spawnProcess?: typeof spawn
  onClose?: (error: AppError) => void
}

/**
 * Start `gitwarren serve --stdio` on `target` and return a way to talk to it.
 *
 * Returns as soon as the process is spawned rather than waiting for the far end
 * to prove itself. There is nothing useful to wait *for*: the daemon announces
 * itself on stderr, not on the protocol, and a handshake would be one more
 * round trip before the first real request could go out. If the host is
 * unreachable the first `request` fails, which is the same thing a caller has
 * to handle anyway.
 */
export function connectOverSsh({
  target,
  spawnProcess = spawn,
  onClose
}: SpawnSshOptions): SshConnection {
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnProcess('ssh', sshArgs(target), {
      // stdin and stdout are the protocol; stderr is diagnostics and must never
      // be merged into it - that is exactly the mistake `stdio-client.ts`
      // reports as "the host sent something that is not part of the protocol".
      stdio: ['pipe', 'pipe', 'pipe'],
      // No shell. `target` comes from a form, and a shell here would make a
      // host label an injection point on the local machine.
      shell: false,
      windowsHide: true
    })
  } catch (error) {
    throw new AppError(
      'HOST_OFFLINE',
      `Could not start ssh: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    // Newest kept, oldest dropped: the last thing said before a failure is the
    // one that explains it.
    stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES)
  })

  let closeError: AppError | null = null

  const client: StdioClient = createStdioClient({
    input: child.stdout,
    output: child.stdin,
    onClose: (error) => {
      closeError = error
      onClose?.(error)
    }
  })

  // A spawn that fails asynchronously - no `ssh` on this machine at all -
  // arrives here rather than as a throw above.
  child.on('error', (error: Error) => {
    stderr = `${stderr}\n${error.message}`.slice(-MAX_STDERR_BYTES)
    client.close(`Could not run ssh: ${error.message}`)
  })

  let exitReason: string | null = null
  const exited: Promise<void> = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      // The far end going away has already been noticed by the client, through
      // the end of stdout. What arrives here is the part that says *why*, and
      // it is what `diagnostics` waits for.
      exitReason = describeExit(target, code, signal, stderr)
      client.close(exitReason)
      resolve()
    })
  })

  return {
    request(method, params) {
      if (isLocalOnly(method)) {
        return Promise.reject(
          new AppError(
            'INVALID_INPUT',
            `"${method}" is answered by this machine and is never sent to a host.`
          )
        )
      }
      return client.request(method, params)
    },
    close() {
      client.close('The connection to the host was closed.')
      // `ssh` exits when its stdin closes and the remote command ends. The kill
      // is the backstop for one that does not, and `SIGTERM` rather than
      // `SIGKILL` so the multiplexing master gets to tidy up its socket.
      child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    },
    isOpen() {
      return client.isOpen()
    },
    async diagnostics() {
      if (exitReason === null && child.exitCode === null && child.signalCode === null) {
        // Still running, or exiting right now. Wait for the status, but never
        // hang a screen on a child that refuses to die.
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, EXIT_GRACE_MS).unref?.())
        ])
      }
      // `describeExit` has already folded the last of stderr into its message,
      // so preferring it avoids saying the same thing twice.
      return (exitReason ?? closeError?.message ?? stderr).trim()
    }
  }
}

export interface RunOverSshOptions {
  target: string
  /** A `sh` script. It crosses as one argument and the login shell runs it. */
  command: string
  /** Piped to the remote command's stdin. This is how a tarball gets there. */
  stdin?: Readable
  spawnProcess?: typeof spawn
}

export interface SshRunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run one command on a host and wait for it to finish.
 *
 * Deliberately resolves on a non-zero exit rather than rejecting. Every caller
 * asks a question the host is allowed to answer with "no": `uname` on a machine
 * that answered ssh, `gitwarren --version` on a machine that has never had
 * GitWarren. Exit 127 *is* the answer to the second, and a throw would make the
 * ordinary first install arrive as a failure. Not reaching the host at all is
 * the exception and does reject, because that is not an answer to anything.
 *
 * stdout is captured whole, which is safe only because everything run through
 * here prints a line or two. The tarball travels the other way, on stdin.
 */
export function runOverSsh({
  target,
  command,
  stdin,
  spawnProcess = spawn
}: RunOverSshOptions): Promise<SshRunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess('ssh', [...SSH_OPTIONS, target, command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // No shell locally, for the reason `connectOverSsh` gives: `target`
        // came from a form. The *remote* shell is what runs `command`, which is
        // why everything interpolated into it is quoted by the caller that
        // built it - see `core/shell-quote.ts`.
        shell: false,
        windowsHide: true
      })
    } catch (error) {
      reject(
        new AppError(
          'HOST_OFFLINE',
          `Could not start ssh: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES)
    })

    child.on('error', (error: Error) => {
      reject(new AppError('HOST_OFFLINE', `Could not run ssh: ${error.message}`))
    })

    if (stdin) {
      // A host that dies mid-transfer closes the pipe under us, and an
      // unhandled EPIPE on a stream nobody awaits takes the whole process down.
      // The exit status below is the real report; this only has to not be fatal.
      child.stdin.on('error', () => {})
      stdin.on('error', (error: Error) => child.stdin.destroy(error))
      stdin.pipe(child.stdin)
    } else {
      child.stdin.end()
    }

    // `close` rather than `exit`: the streams have to be drained before stdout
    // is read, and `exit` can arrive with the last chunk still in flight.
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new AppError('HOST_OFFLINE', `ssh to ${target} was terminated (${signal}).`))
        return
      }
      // 255 is ssh's own "I could not do my half of this", and is never the
      // remote command's status. See `describeExit`.
      if (code === 255) {
        reject(new AppError('HOST_OFFLINE', describeExit(target, code, null, stderr)))
        return
      }
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}

/**
 * Methods this install answers for itself, whatever host is being looked at.
 *
 * See the note at the top of the file. A prefix rather than a list of names, so
 * that adding `hosts.rename` tomorrow cannot accidentally become forwardable.
 */
export function isLocalOnly(method: string): boolean {
  return method.startsWith('hosts.')
}

/**
 * Turn an exit status into something worth putting on a screen.
 *
 * `ssh` has one exit code for "everything that went wrong on my side" (255) and
 * otherwise passes through the remote command's, so 127 really does mean the
 * launcher is not there - which before M4.2 is the single most likely outcome
 * of adding a host, and deserves to say what to do about it rather than
 * "exited with code 127".
 */
function describeExit(
  target: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string
): string {
  const tail = stderr.trim().split('\n').slice(-3).join(' ').trim()
  const detail = tail ? ` ${tail}` : ''

  if (code === 127) {
    return (
      `GitWarren is not installed on ${target}: ${REMOTE_LAUNCHER} was not found.` +
      ' Install the daemon on the host and try again.'
    )
  }
  if (code === 255) return `ssh could not connect to ${target}.${detail}`
  if (signal) return `The connection to ${target} was terminated (${signal}).${detail}`
  return `The connection to ${target} ended (exit ${code ?? 'unknown'}).${detail}`
}
