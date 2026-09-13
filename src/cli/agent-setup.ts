/**
 * `gitwarren agent-setup` - the Agent Access page, for a host with no page.
 *
 * The prompt is a sentence a person moves from GitWarren into an agent. On a
 * desktop that is a copy button; over ssh, on a VPS, inside a container or in
 * the WSL session M5 is about, there is no window to press it in - and those
 * are exactly the machines where an agent is most likely to be the only thing
 * that ever talks to this install. So the same words come out of a command.
 *
 * It reads from `@shared/agent-setup`, which the page also reads, so the two
 * cannot drift. What this file adds is the part a terminal can say and a page
 * cannot: whether the launcher is actually on this machine yet, and what to
 * type if it is not.
 *
 * ## It writes the launcher it names
 *
 * The first version of this printed the path and, when nothing was there,
 * pointed at `gitwarren service install` - on the principle that a command
 * that reports should not change the machine. That principle sent a person
 * who had asked "how does my agent reach this" to a command about logging in,
 * and the sentence it printed named a file that did not exist. Somebody who
 * runs `agent-setup` wants the agent to work; the launcher is a two-line
 * script at a path they can read, and the app writes the same file on every
 * launch without asking. So this writes it too, says so once on stderr when
 * it did, and still asks for no login item.
 */
import { existsSync } from 'node:fs'
import { getMcpLauncherPath } from '../core/mcp-launcher.js'
import { agentConfigSnippets, agentSetupPrompt } from '../shared/agent-setup.js'
import { ensureLaunchers } from './launchers.js'

const USAGE = `gitwarren agent-setup [--manual]

Prints the sentence to paste into an agent so it can reach this machine's
GitWarren over MCP.

  --manual   also print the configuration for each harness that would rather be
             edited by hand than told.
`

/**
 * The prompt, and then the state of the machine it names.
 *
 * The prompt goes to stdout and everything else to stderr, so
 * `gitwarren agent-setup | pbcopy` copies the sentence and nothing else - which
 * is the shape of the thing, and the reason a status line does not simply get
 * printed underneath it.
 */
export function runAgentSetup(argv: readonly string[]): boolean {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return true
  }

  const rest = argv.filter((argument) => argument !== '--manual')
  if (rest.length > 0) {
    console.error(USAGE)
    return false
  }

  const command = getMcpLauncherPath()
  console.log(agentSetupPrompt({ command }))

  if (argv.includes('--manual')) {
    for (const snippet of agentConfigSnippets({ command })) {
      console.log(`\n# ${snippet.label} - ${snippet.hint.replaceAll('`', '')}`)
      console.log(snippet.text.trimEnd())
    }
  }

  // Written after the prompt rather than before it, so the sentence on stdout
  // is the same whether or not this run had anything to write.
  const launchers = ensureLaunchers()
  if (launchers.created.includes(command)) {
    console.error(`\n[gitwarren] wrote ${command}, which the sentence above names.`)
  } else if (!existsSync(command)) {
    // Not an error: the prompt above is still the right prompt, and it will be
    // true the moment the launcher exists. Worth a line on stderr all the same
    // - an agent handed this today would report a command that is not there.
    console.error(
      `\n[gitwarren] no launcher at ${command} yet, and this run could not write one` +
        (launchers.refused ? `: ${launchers.refused}` : '.')
    )
  }

  return true
}
