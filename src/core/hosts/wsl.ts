/**
 * `wsl.exe`, as a way of starting a daemon and talking to it.
 *
 * The same shape as `ssh.ts` and for the same reason: the protocol is
 * `shared/rpc.ts`, the framing is `core/rpc/ndjson.ts`, the asking side is
 * `core/rpc/stdio-client.ts`, and what answers on the far end is the same
 * `gitwarren serve --stdio` the daemon has run since M2. This module
 * contributes a child process and an argument vector, exactly as M4.1 said a
 * carrier should.
 *
 * What it does *not* share with `ssh.ts` is every one of the four things below,
 * and each was found by running the thing rather than by reading Microsoft's
 * documentation.
 *
 * ## The command, and why it goes through `-e sh -c`
 *
 *   wsl.exe -d <distro> -e sh -c 'exec ~/.gitwarren/bin/gitwarren serve --stdio'
 *
 * The obvious spelling is `wsl.exe -d <distro> -- ~/.gitwarren/bin/gitwarren
 * serve --stdio`, and it works. It is still wrong, and the reason it is wrong
 * is worth the extra two arguments.
 *
 * With `--`, `wsl.exe` hands the words to the distro's *login shell*, which
 * expands parameters and tildes in each of them and then execs the result
 * without any parsing: no word splitting, no quoting, no operators. So
 * `-- 'echo $HOME'` as one argument tries to exec a file called
 * `echo /home/xfor`, and - much worse - `-- sh -c '<script>'` has the script's
 * `$root` and `$$` expanded by the *outer* shell before the inner `sh` ever sees
 * them. That failure is silent and plausible: `$$` still produces a number, just
 * the wrong process's, and a script that names a scratch directory after it
 * stops being unique per install. Measured here - the outer shell answered 1269
 * where the inner one answered 1274.
 *
 * `-e` skips the login shell entirely, so the argument vector arrives at `exec`
 * untouched. Naming `sh` ourselves then buys back the two things the login shell
 * was doing for us, under our own control: `~` is expanded by the inner shell,
 * and a multi-line script crosses as one argument exactly as it does over `ssh`.
 * It is also strictly more predictable than `ssh`'s arrangement, where the
 * remote *login* shell runs the command and M4.2 discovered that on this very
 * box it is `zsh`. Here it is always `sh`.
 *
 * `exec` so that no shell sits between `wsl.exe` and the daemon holding the
 * pipe open. A process inside the distro is what stops WSL idling the virtual
 * machine down, and one of them is enough.
 *
 * ## `WSL_UTF8=1`, because otherwise two encodings share one pipe
 *
 * `wsl.exe` writes its *own* messages as UTF-16LE while the guest's output is
 * UTF-8, so a stream can carry both and `setEncoding('utf8')` turns half of it
 * into mojibake: "There is no distribution with the supplied name." arrives as
 * `T\0h\0e\0r\0e\0…`. `WSL_UTF8=1` (WSL 0.64 and later) makes `wsl.exe` speak
 * UTF-8 too. It is set on the child rather than on this process because it
 * changes the output of a program we are parsing and nothing else should have
 * to know.
 *
 * ## `wsl.exe` writes its errors to stdout, which is the protocol
 *
 * This is the one that has no `ssh` analogue at all. `ssh` puts its complaints
 * on stderr and leaves stdout to the remote command - M4.1 relied on that, and
 * the daemon's ready banner is on stderr for the same reason. `wsl.exe` puts
 * "There is no distribution with the supplied name." on **stdout**, in front of
 * a stream that is supposed to carry nothing but ndjson frames.
 *
 * Nothing can stop it, so the frame reader sees a line that is not JSON and
 * shuts the connection down saying the host is "not part of the protocol …
 * usually a login script printing to stdout" - true in shape and wrong about
 * the cause. What fixes it is that `diagnostics()` gets the last word: a
 * bounded prefix of stdout is kept, the lines of it that are not frames are
 * exactly what `wsl.exe` said, and `describeWslExit` puts them in the message
 * the person reads. The prefix is bounded and is only ever the start of the
 * stream, because `wsl.exe` has said whatever it is going to say before the
 * guest produces a byte.
 *
 * ## There is no `BatchMode`, because there is nothing to prompt for
 *
 * `ssh` needed `BatchMode=yes` to turn a passphrase prompt into an error.
 * `wsl.exe` never authenticates - the distro belongs to the Windows user
 * already - so the hang it prevents does not exist here. What does exist is a
 * set of failures that all arrive as an exit status with some words attached,
 * and `describeWslExit` is where each becomes a sentence instead of a wait.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import { createStdioClient, type StdioClient } from '../rpc/stdio-client.js'
import {
  diagnosticTail,
  isLocalOnly,
  offline,
  EXIT_GRACE_MS,
  MAX_STDERR_BYTES,
  REMOTE_LAUNCHER,
  type HostConnection,
  type HostRunResult
} from './carrier.js'
import { AppError } from '../../shared/errors.js'

/**
 * How much of stdout to keep in case it turns out to be `wsl.exe` talking.
 *
 * Small on purpose. Everything `wsl.exe` says, it says before the guest starts,
 * so this only ever holds the first few lines of a stream - and on a healthy
 * connection those are protocol frames that `wslSaid` discards. It is not a
 * second copy of the conversation.
 */
const MAX_PREAMBLE_BYTES = 4 * 1024

/**
 * What `wsl.exe` returns when it could not do its half at all.
 *
 * `-1`, which Windows reports as an unsigned DWORD and Node hands back as
 * 4294967295. Both spellings are checked because which one arrives is a detail
 * of the platform rather than a promise, and this is the status for every
 * failure that is `wsl.exe`'s own: no such distribution, WSL not enabled, the
 * service not running. What distinguishes them is the sentence, not the code,
 * which is why the sentence is carried rather than mapped.
 */
const WSL_OWN_FAILURE = [-1, 4294967295]

/**
 * The environment `wsl.exe` is given.
 *
 * `WSL_UTF8` only. Deliberately layered onto the caller's environment rather
 * than replacing it: `wsl.exe` needs the Windows user's context to find the
 * distribution at all, and a clean environment would be a way of breaking that
 * for no benefit.
 */
export function wslEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, WSL_UTF8: '1' }
}

/** The argument vector that starts the daemon in `distro`. */
export function wslArgs(distro: string): string[] {
  return ['-d', distro, '-e', 'sh', '-c', `exec ${REMOTE_LAUNCHER} serve --stdio`]
}

/** The argument vector that runs one `sh` script in `distro`. */
export function wslRunArgs(distro: string, command: string): string[] {
  return ['-d', distro, '-e', 'sh', '-c', command]
}

export interface SpawnWslOptions {
  distro: string
  /** Swappable so the tests can run a fake distro without WSL on the box. */
  spawnProcess?: typeof spawn
  onClose?: (error: AppError) => void
}

/**
 * Start `gitwarren serve --stdio` in `distro` and return a way to talk to it.
 *
 * Returns as soon as the process is spawned rather than waiting for the far end
 * to prove itself, for the reason `connectOverSsh` gives: the daemon announces
 * itself on stderr, not on the protocol, and a handshake would be one more round
 * trip before the first real request could go out.
 */
export function connectOverWsl({
  distro,
  spawnProcess = spawn,
  onClose
}: SpawnWslOptions): HostConnection {
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnProcess('wsl.exe', wslArgs(distro), {
      // stdin and stdout are the protocol; stderr is diagnostics. Unlike `ssh`,
      // stdout is not exclusively the far end's - see the note at the top.
      stdio: ['pipe', 'pipe', 'pipe'],
      // No shell. `distro` comes from a picker, and a shell here would make a
      // distribution name an injection point on the *Windows* machine.
      shell: false,
      windowsHide: true,
      env: wslEnvironment()
    })
  } catch (error) {
    throw offline(
      `Could not start wsl.exe: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  // Attached before the client, so that nothing has switched the stream into
  // flowing mode yet and no chunk can be delivered to one reader and not the
  // other. `setEncoding` is idempotent and `readFrames` asks for the same one.
  let preamble = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    // Oldest kept, newest dropped - the opposite of stderr below, and on
    // purpose. What is worth having here is whatever came *before* the guest
    // started, because that is the only thing on this stream that `wsl.exe`
    // itself wrote.
    if (preamble.length < MAX_PREAMBLE_BYTES) {
      preamble = (preamble + chunk).slice(0, MAX_PREAMBLE_BYTES)
    }
  })

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

  // A spawn that fails asynchronously - no `wsl.exe` on this machine at all,
  // which is what a Windows install without WSL looks like - arrives here
  // rather than as a throw above.
  child.on('error', (error: Error) => {
    stderr = `${stderr}\n${error.message}`.slice(-MAX_STDERR_BYTES)
    client.close(`Could not run wsl.exe: ${error.message}`)
  })

  let exitReason: string | null = null
  const exited: Promise<void> = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exitReason = describeWslExit(distro, code, signal, preamble, stderr)
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
      // `wsl.exe` exits when its stdin closes and the guest command ends. The
      // kill is the backstop for one that does not.
      child.stdin.end()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    },
    isOpen() {
      return client.isOpen()
    },
    async diagnostics() {
      if (exitReason === null && child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, EXIT_GRACE_MS).unref?.())
        ])
      }
      return (exitReason ?? closeError?.message ?? diagnosticTail(stderr)).trim()
    }
  }
}

export interface RunOverWslOptions {
  distro: string
  /** A `sh` script. It crosses as one argument and the inner `sh` runs it. */
  command: string
  /** Piped to the command's stdin. This is how a tarball gets there. */
  stdin?: Readable
  spawnProcess?: typeof spawn
}

/**
 * Run one command in a distro and wait for it to finish.
 *
 * The counterpart of `runOverSsh`, down to resolving on a non-zero exit rather
 * than rejecting: every caller asks a question the distro is allowed to answer
 * with "no", and exit 127 *is* the answer to "have you got GitWarren". Not
 * reaching the distro at all is the exception and does reject, because that is
 * not an answer to anything.
 *
 * stdout is captured whole, which is safe only because everything run through
 * here prints a line or two. The tarball travels the other way, on stdin.
 */
export function runOverWsl({
  distro,
  command,
  stdin,
  spawnProcess = spawn
}: RunOverWslOptions): Promise<HostRunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess('wsl.exe', wslRunArgs(distro, command), {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        env: wslEnvironment()
      })
    } catch (error) {
      reject(
        offline(
          `Could not start wsl.exe: ${error instanceof Error ? error.message : String(error)}`
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
      reject(offline(`Could not run wsl.exe: ${error.message}`))
    })

    if (stdin) {
      // A distro that dies mid-transfer closes the pipe under us, and an
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
        reject(offline(`wsl.exe for ${distro} was terminated (${signal}).`))
        return
      }
      if (code !== null && WSL_OWN_FAILURE.includes(code)) {
        // `wsl.exe`'s own failure, and it put the reason on stdout. Never the
        // guest command's status - see `describeWslExit`.
        reject(offline(describeWslExit(distro, code, null, stdout, stderr)))
        return
      }
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}

/**
 * What `wsl.exe` said on stdout, as opposed to what the daemon said.
 *
 * A protocol frame is a JSON object, so a line that does not begin with `{` was
 * not one. That is a cheaper test than parsing and an honest one: the question
 * being asked is not "is this valid JSON" but "did something other than the
 * protocol write here", and the answer only has to be right about lines a
 * person is going to read.
 *
 * Exported for its own test, because the case it exists for - a message from
 * the carrier arriving in the middle of the carrier's own data stream - is the
 * single most surprising thing about this file.
 */
export function wslSaid(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('{'))
    .slice(0, 3)
    .join(' ')
    .trim()
}

/**
 * Turn an exit status into something worth putting on a screen.
 *
 * The four failures a person actually meets, and what each looks like here:
 *
 * - *The distribution is not installed, or WSL is not enabled.* `wsl.exe`'s own
 *   status, with its own sentence on stdout. Carried rather than mapped - it
 *   names the thing that is missing, and a translation of it could only be
 *   vaguer.
 * - *GitWarren is not installed in the distro.* Exit 127 from `sh`, exactly as
 *   over `ssh`, which is why the sentence is the same one.
 * - *The distro was shut down under us.* `wsl --terminate`, or WSL deciding the
 *   virtual machine has been idle long enough. Exit 1 and **not one word** on
 *   either stream - measured - so this is the one case where the message has to
 *   be invented rather than quoted, and it is worded as a possibility because
 *   that is all the evidence supports.
 * - *The wrong architecture.* Not visible here at all: it gets as far as a
 *   perfectly successful `tar` and dies at the first `exec`, during an install
 *   someone is watching. See `core/hosts/install.ts`.
 *
 * Exported for its own test. Everything else about a connection needs a real
 * `wsl.exe` to say anything about, and this is the one part that is a pure
 * function of an exit status and two streams.
 */
export function describeWslExit(
  distro: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string
): string {
  const said = [wslSaid(stdout), diagnosticTail(stderr)].filter(Boolean).join(' ')
  const detail = said ? ` ${said}` : ''

  if (code !== null && WSL_OWN_FAILURE.includes(code)) {
    return `wsl.exe could not start ${distro}.${detail}`
  }
  if (code === 127) {
    return (
      `GitWarren is not installed on ${distro}: ${REMOTE_LAUNCHER} was not found.` +
      ' Install the daemon on the host and try again.'
    )
  }
  if (signal) return `The connection to ${distro} was terminated (${signal}).${detail}`
  if (code === 1 && !said) {
    // Nothing was said by anybody, which is what a distribution being shut down
    // looks like from out here: `wsl --terminate` ends the pipe and exits 1 in
    // silence. A daemon that failed on its own would have said so on stderr.
    return (
      `The connection to ${distro} ended without saying why.` +
      ' The distribution may have been shut down, by `wsl --terminate` or by WSL idling it out.'
    )
  }
  return `The connection to ${distro} ended (exit ${code ?? 'unknown'}).${detail}`
}
