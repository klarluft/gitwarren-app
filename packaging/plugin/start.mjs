#!/usr/bin/env node
/**
 * The Claude Code plugin's starter: which GitWarren answers this agent.
 *
 * `.mcp.json` at the repository root names this file, and Claude Code runs it
 * whenever the plugin's server is needed. It carries no GitWarren of its own.
 * It decides between two, and the rule is short enough to say in one sentence:
 * a GitWarren that is already running on this machine answers, and otherwise
 * the published package does, with the review page switched on.
 *
 * ## Why "running", not "installed"
 *
 * The obvious rule - use the installed app whenever there is one - hands out
 * dead links. The launcher the app writes starts the MCP server and nothing
 * else, which is right when the app is up and owns the port, and wrong when
 * the app is installed but closed: the agent would say "here is your review"
 * and the link would refuse. `gitwarren mcp --serve` exists so that a link is
 * never dead while the agent is connected, and the only way to keep that
 * promise is to ask whether something is *listening*, which is what the owner
 * file says. When it is, links open there and this must not compete for the
 * port; when it is not, this serves the page itself.
 *
 * The cost is a version difference between an installed-but-closed app and
 * the package `npx` fetches, against the same database. `cli/launchers.ts`
 * already accepts exactly that between the app and the command-line install,
 * and the app keeps itself current, so the window is small.
 *
 * ## No dependencies, no build
 *
 * This runs before anything of GitWarren's is on the machine, so it cannot
 * import from it. The two things it has to know - where the data directory is
 * and what the owner file looks like - are copied from `core/paths.ts` and
 * `core/daemon-runtime.ts` and must be kept in step with them by hand. Both
 * have been stable since M2 and are named in `docs/` as a compatibility
 * promise, which is the only reason copying is acceptable here.
 *
 * ## The child owns stdio
 *
 * Whatever is chosen is spawned with this process's stdin and stdout, because
 * they are the protocol and this file must never write to them. Signals are
 * forwarded and the exit code is the child's, so to Claude Code this is
 * indistinguishable from having started the server directly.
 *
 * `npx` is found through the npm that ships with this Node rather than by
 * name: on Windows `npx` is a `.cmd`, which Node refuses to spawn without a
 * shell since the fix for CVE-2024-27980, and a shell would concatenate rather
 * than escape. `scripts/run-tests.mjs` resolves `tsx` the same way for the same
 * reason. The name is the fallback, with a shell, for a Node installed without
 * its npm.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const WINDOWS = process.platform === 'win32'

/** Mirrors `getDataDirectory` in `core/paths.ts`. */
function dataDirectory() {
  const override = process.env.GITWARREN_DATA_DIR?.trim()
  if (override) return override
  switch (process.platform) {
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'GitWarren')
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'GitWarren')
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'GitWarren')
  }
}

/** Mirrors `getMcpLauncherPath` in `core/mcp-launcher.ts`. */
function launcherPath() {
  return join(homedir(), '.gitwarren', 'bin', WINDOWS ? 'gitwarren-mcp.cmd' : 'gitwarren-mcp')
}

/**
 * Is a GitWarren listening on this machine? Mirrors `readLiveDaemonRuntime`:
 * the owner file is a hint until its pid answers, because a crash leaves the
 * file behind. Any way of not knowing is "no", which is the safe answer - it
 * means serving the page, and `gitwarren mcp --serve` checks again for itself.
 */
function ownerIsListening() {
  try {
    const runtime = JSON.parse(readFileSync(join(dataDirectory(), 'daemon-runtime.json'), 'utf8'))
    if (typeof runtime.pid !== 'number' || runtime.linkPort === null) return false
    process.kill(runtime.pid, 0)
    return true
  } catch (error) {
    // EPERM is a live process that is not ours to signal, which still answers
    // the question asked.
    return error?.code === 'EPERM'
  }
}

/** The `npx` that belongs to this Node, as a script this Node can run. */
function npxCli() {
  const bin = dirname(process.execPath)
  const candidates = [
    join(bin, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('error', (error) => {
    console.error(`[gitwarren-plugin] could not start ${command}: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0))
  })
}

const launcher = launcherPath()

if (ownerIsListening() && existsSync(launcher)) {
  console.error('[gitwarren-plugin] GitWarren is running here; using its own MCP server')
  // The launcher is a `.cmd` on Windows and so needs the shell; the quotes
  // survive a profile directory with a space in it.
  run(WINDOWS ? `"${launcher}"` : launcher, [], { shell: WINDOWS })
} else {
  const args = ['-y', 'gitwarren', 'mcp', '--serve']
  const cli = npxCli()
  if (cli) {
    run(process.execPath, [cli, ...args])
  } else {
    run(WINDOWS ? 'npx.cmd' : 'npx', args, { shell: WINDOWS })
  }
}
