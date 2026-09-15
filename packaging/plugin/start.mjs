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
 *
 * ## npx must not mistake the user's project for the package
 *
 * Claude Code starts this with the user's project as the working directory,
 * and `npx gitwarren` in a directory whose package.json is *named* gitwarren
 * resolves to that project rather than to the registry - which has no
 * executable, so npx stops with "could not determine executable to run".
 * The one project where that is certain is this repository, which is also
 * the one its maintainers use the plugin on. Found there, on the second
 * attempt to use the plugin.
 *
 * Two things, either of which is enough. The package is named as
 * `gitwarren@latest`, which npm reads as a registry request even beside a
 * local project of that name - a bare name or a pinned version does not.
 * And npx runs from the system's temporary directory rather than the
 * project, so there is no local project for it to consider at all. The server
 * does not care where it runs: the database is at a fixed path, and the
 * repositories an agent adds are absolute paths.
 *
 * ## The Node on the PATH has to be new enough
 *
 * `better-sqlite3` ships one prebuilt binary per platform, built against
 * Node-API 10. Under a Node with Node-API 9 - any 22.x before 22.14 - it loads
 * fine and segfaults the first time a database is opened, and what Claude
 * Code shows for that is "server failed to connect" and nothing more. This was
 * found on the first machine the plugin was tried on: a shell whose default
 * Node was 22.12, on a repository whose `.nvmrc` said 24.
 *
 * Claude Code runs this with whatever `node` is first on the PATH, and this
 * file cannot pick a different one for it. What it can do is say so, before
 * spawning anything, in a sentence that names the version it found and the
 * one it needs. The check is on Node-API rather than on a Node version,
 * because that is the thing the binary is actually built against.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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

/** What the SQLite prebuild is built against. See the header. */
const NODE_API_NEEDED = 10

/** The Node line people are likeliest to be on, and its first good release. */
const NODE_NEEDED = 'Node 22.14 or newer, or Node 24'

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
    if (signal === 'SIGSEGV' || code === 139) {
      // Said here because the process that crashed cannot say anything, and
      // "server failed to connect" is all the agent would otherwise show.
      console.error(
        `[gitwarren-plugin] GitWarren crashed on start under Node ${process.versions.node}. ` +
          `Its SQLite module needs ${NODE_NEEDED}; if this Node is newer than that, ` +
          `the npx cache may hold a broken install - remove its gitwarren entry and start again.`
      )
    }
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
  if (Number(process.versions.napi) < NODE_API_NEEDED) {
    // Before spawning anything: npx would download the package, and the
    // server would then crash on its first database read with no words.
    console.error(
      `[gitwarren-plugin] Node ${process.versions.node} is too old for GitWarren's SQLite ` +
        `module, which needs ${NODE_NEEDED} (Node-API ${NODE_API_NEEDED}; this one has ` +
        `${process.versions.napi}). Claude Code starts this with the first \`node\` on your ` +
        `PATH - make a newer one the default, for example \`fnm default 24\` or ` +
        `\`nvm alias default 24\`, then restart Claude Code.`
    )
    process.exit(1)
  }

  const args = ['-y', 'gitwarren@latest', 'mcp', '--serve']
  // See the header: away from the project, so npx cannot mistake it for the
  // package.
  const cwd = tmpdir()
  const cli = npxCli()
  if (cli) {
    run(process.execPath, [cli, ...args], { cwd })
  } else {
    run(WINDOWS ? 'npx.cmd' : 'npx', args, { shell: WINDOWS, cwd })
  }
}
