/**
 * Agent Access - the one screen whose job is to be pasted somewhere else.
 *
 * It leads with a sentence. Not a JSON snippet, not a picker of harnesses, not
 * a wizard: one paragraph that names a command and asks the agent to register
 * it and then call it. An agent knows its own configuration format - which
 * file, which key, whether it needs a reload - better than this page can, and
 * it knows it for harnesses that did not exist when this was written. The one
 * thing it cannot know is the command, and `~/.gitwarren/bin/gitwarren-mcp` is
 * the same command on every machine and after every update, which is what makes
 * a sentence enough. The text itself is in `@shared/agent-setup`, because
 * `gitwarren agent-setup` prints the same words on a host with no UI.
 *
 * The per-harness snippets are still here, behind "configure by hand", for
 * someone who would rather edit the file themselves. They are second on the
 * page on purpose: JSON pasted into the wrong file, under the wrong key or with
 * a trailing comma is the failure the sentence exists to remove, and putting it
 * first invites exactly that.
 *
 * ## A page rather than a disclosure
 *
 * It was a collapsible card on the home screen until M3.4. Two things made it a
 * location: a browser tab, where a URL is how you get this in front of the
 * person - or the agent - being configured; and M4, where there is one of these
 * per host and `#/h/<id>/agent` is how you say which. Both are reasons to be
 * addressable, and neither is served by a card that has to be scrolled to and
 * clicked open.
 *
 * ## Two shells, one page
 *
 * Nothing here is Electron. `app-info` answers over the socket in a tab exactly
 * as it does over IPC in the window, the launcher path is computed from the
 * same `core/mcp-launcher.ts` in both, and the clipboard is the web one either
 * way. The only thing that differs is what the install has to say for itself,
 * which arrives as `mcp.note`.
 *
 * ## One of these per machine
 *
 * `#/h/<id>/agent` is this page about a host, and what changes is where the
 * launcher path comes from: `app.mcp` over the carrier rather than the shell's
 * own `app-info`, because `~/.gitwarren/bin/gitwarren-mcp` has to be resolved by
 * the machine whose `~` it is. The prompt and the snippets are then built from
 * that command by the same `@shared/agent-setup` the host's own `gitwarren
 * agent-setup` prints - so a person who runs the command on the host and a
 * person who reads this page on their Mac are looking at the same sentence.
 *
 * The words around it change, and that is the load-bearing part. This page is
 * an instruction, and the one way it can be harmful is by being confidently
 * about the wrong computer - so a host's copy says "an agent running on that
 * machine", and anything this install knows only about *itself* (its database,
 * its version, its link port) is left out rather than repeated under another
 * machine's heading.
 */
import { useRef, useState } from 'react'
import useSWR from 'swr'
import { AlertTriangle, ArrowLeft, ChevronDown, Plug } from 'lucide-react'
import { Breakable } from '@/components/breakable'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { CACHE_KEYS } from '@/lib/api'
import { useApi, useHost, useHostScope } from '@/lib/host-scope'
import { navigate } from '@/lib/router'
import { LINK_SERVER_PORT } from '@shared/link-port'
import {
  agentConfigSnippets,
  agentSetupPrompt,
  type AgentConfigSnippet
} from '@shared/agent-setup'
import { cn } from '@/lib/utils'
import type { AppInfo, McpLaunchInfo } from '@shared/api'

/**
 * One format, its own `<pre>` and its own copy button.
 *
 * A component rather than three elements inside the map, because the button
 * needs a ref to the block it would select and a ref cannot be made inside a
 * loop. It also puts each panel's copied state where it belongs, which is one
 * per panel.
 */
function SnippetPanel({ snippet }: { snippet: AgentConfigSnippet }) {
  const textRef = useRef<HTMLPreElement>(null)

  return (
    <TabsPanel value={snippet.id}>
      <p className="mb-2 text-xs text-muted-foreground">
        {snippet.label} — goes in {snippet.hint.replaceAll('`', '')}.
      </p>
      <div className="relative">
        <pre
          ref={textRef}
          data-selectable
          className="max-h-64 overflow-auto rounded-md bg-muted p-3 pr-12 font-mono text-[11px] leading-relaxed"
        >
          {snippet.text}
        </pre>
        <CopyButton
          label={`Copy the ${snippet.label} configuration`}
          text={snippet.text}
          source={textRef}
          className="absolute right-1.5 top-1.5"
        />
      </div>
    </TabsPanel>
  )
}

/**
 * A note written for a terminal, shown in a window.
 *
 * `mcp.note` is one string with two readers - `gitwarren agent-setup` prints it
 * to a shell and this page renders it - so it names commands in backticks, the
 * one markup both can live with. A terminal shows them; here they would be
 * literal grave accents in the middle of a sentence, so they become the code
 * span they were always standing in for.
 */
function withCode(text: string): React.ReactNode[] {
  return text.split('`').map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} data-selectable className="font-mono">
        {part}
      </code>
    ) : (
      <span key={index}>{part}</span>
    )
  )
}

/** Something the user has to know before the prompt will work. */
function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span className="[overflow-wrap:anywhere]">
        {typeof children === 'string' ? withCode(children) : children}
      </span>
    </p>
  )
}

/**
 * The one install this page is about, and what it can say for itself.
 *
 * Two reads rather than one, because the two questions are genuinely different.
 * For this machine, `system.appInfo` is the shell's own answer and carries
 * `linkPort` along with it. For a host, `app.mcp` goes over the carrier and
 * comes back with the launcher path *as that machine resolves it* - the whole
 * reason this is not just a string built here, since a Mac has no idea what `~`
 * is on `pc-wsl`.
 *
 * `linkPort` is deliberately absent for a host. The warning it drives is about
 * whether a `gitwarren://` link an agent hands *you* will open, which is a fact
 * about the computer you are sitting at; a link written on the host is a local
 * link over there, and M6 is where that grows a host segment. Saying nothing is
 * more honest than repeating this machine's answer under another machine's
 * heading.
 */
function useMcpFor(host: string | undefined): {
  mcp: McpLaunchInfo | undefined
  linkPort: number | null | undefined
  /** Everything only this install can say about itself. Undefined for a host. */
  local: AppInfo | undefined
  isLoading: boolean
} {
  const api = useApi()
  const here = useSWR(host === undefined ? CACHE_KEYS.appInfo : null, () => api.system.appInfo())
  const there = useSWR(host === undefined ? null : CACHE_KEYS.agentMcp(host), () => api.app.mcp())

  return host === undefined
    ? {
        mcp: here.data?.mcp,
        linkPort: here.data?.linkPort,
        local: here.data,
        isLoading: here.isLoading
      }
    : { mcp: there.data, linkPort: undefined, local: undefined, isLoading: there.isLoading }
}

export function AgentAccessPage() {
  const host = useHost()
  const hostScope = useHostScope()
  const { mcp, linkPort, local, isLoading } = useMcpFor(host)
  const [manual, setManual] = useState(false)
  const promptRef = useRef<HTMLParagraphElement>(null)

  if (isLoading || !mcp) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading agent access">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  const prompt = agentSetupPrompt(mcp)
  const snippets = agentConfigSnippets(mcp)
  // Only worth showing when it is not the launcher again. In the app it is
  // Electron-run-as-node plus a script inside the install; in a daemon there is
  // nothing behind the launcher and repeating it would read as a second option.
  const direct = mcp.direct.command === mcp.command ? null : mcp.direct

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-2 text-muted-foreground"
          // Carries the host, or walks the reader off the machine they are
          // reading about - the rule every host-scoped screen follows.
          onClick={() => navigate({ name: 'repositories', ...hostScope })}
        >
          <ArrowLeft />
          Repositories
        </Button>

        <div className="flex items-center gap-2">
          <Plug className="size-5 shrink-0 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">Agent access</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {host === undefined
            ? 'Give an AI agent one sentence and it will configure itself to read and write these reviews over MCP.'
            : // Named as a place the agent already is, because that is the thing
              // to get right: this command is for a session running on that
              // machine, and pasting it into an agent here would configure a
              // server that does not exist. Which machine "there" is, the host
              // banner above every screen already says.
              'Paste this into an agent running on that machine, and it will configure itself to read and write its reviews over MCP.'}
        </p>
      </div>

      {/* The lead. Everything else on the page is a footnote to it. */}
      <Card className="p-4">
        <p className="text-sm font-medium">
          {host === undefined
            ? 'Paste this into whichever agent you use'
            : 'Paste this into an agent on that machine'}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Claude Code, Codex, Cursor, Gemini CLI — anything that speaks MCP. It will work out
          where its own configuration goes.
        </p>

        <p
          ref={promptRef}
          data-selectable
          className="mt-3 rounded-md bg-muted p-3 text-sm leading-relaxed [overflow-wrap:anywhere]"
        >
          {prompt}
        </p>

        <CopyButton label="Copy this prompt" text={prompt} source={promptRef} className="mt-3">
          Copy prompt
        </CopyButton>
      </Card>

      {(mcp.note || !mcp.available || linkPort === null) && (
        <div className="flex flex-col gap-2">
          {/* The install's own words first. Each shell knows a different reason
              the launcher might not be there and a different way to fix it -
              `npm run build` in a checkout, `gitwarren service install` on a
              machine with no app - and neither of them is this page's to guess.
              A host's note comes from the host, which is the point: it is that
              machine describing its own missing launcher. */}
          {mcp.note ? (
            <Warning>{mcp.note}</Warning>
          ) : (
            !mcp.available && (
              <Warning>
                {host === undefined
                  ? 'The MCP server is not on this machine yet, so the command above does not exist until it is. The prompt itself will not change.'
                  : 'The MCP server is not on that machine yet, so the command above does not exist until it is. Installing the daemon from the Hosts screen writes it.'}
              </Warning>
            )
          )}

          {/* Only ever asked about this machine - `linkPort` is undefined for a
              host, so this is skipped rather than answered wrongly. See
              `useMcpFor`. */}
          {linkPort === null && (
            <Warning>
              Another program is using port {LINK_SERVER_PORT}, so links an agent hands you will
              not open GitWarren until it lets go. Everything else works, and the links themselves
              are still correct — they name the same port on every machine.
            </Warning>
          )}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setManual((value) => !value)}
          aria-expanded={manual}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn('size-3 transition-transform', manual && 'rotate-180')} />
          Configure by hand
        </button>

        {manual && (
          <Card className="mt-2 p-4">
            <p className="mb-3 text-xs text-muted-foreground">
              The same command, in the syntax each harness reads it in. Merge it into whatever is
              already there rather than replacing the file.
            </p>

            <Tabs defaultValue={snippets[0]?.id}>
              <TabsList>
                {snippets.map((snippet) => (
                  <TabsTab key={snippet.id} value={snippet.id}>
                    {snippet.id === 'mcp-servers' ? 'mcpServers' : snippet.label}
                  </TabsTab>
                ))}
              </TabsList>

              {snippets.map((snippet) => (
                <SnippetPanel key={snippet.id} snippet={snippet} />
              ))}
            </Tabs>

            {direct && (
              <p className="mt-3 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                If the launcher above cannot be used, the server is also reachable directly at{' '}
                <code data-selectable className="font-mono">
                  {[direct.command, ...direct.args].join(' ')}
                </code>
                {Object.keys(direct.env).length > 0 && (
                  <>
                    {' '}
                    with{' '}
                    <code data-selectable className="font-mono">
                      {Object.entries(direct.env)
                        .map(([key, value]) => `${key}=${value}`)
                        .join(' ')}
                    </code>
                  </>
                )}
                . That one points inside this install and needs updating if GitWarren moves,
                which is the whole reason the launcher exists.
              </p>
            )}
          </Card>
        )}
      </div>

      <Card className="p-4">
        <dl className="space-y-1.5 text-xs">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-muted-foreground">Command</dt>
            {/* Wraps rather than truncates: a path the user cannot read whole
                and cannot select is worse than one that takes two lines. And it
                wraps at its separators - `overflow-wrap: anywhere` on its own
                broke these mid-segment, turning a launcher path into
                `/Users/somebody/.gitwar` + `ren/bin/gitwarren-mcp`, which is
                a thing a reader has to reassemble before they can check it. */}
            <dd data-selectable className="break-words font-mono">
              <Breakable text={mcp.command} />
            </dd>
          </div>
          {/* Where the database is and which version is running are facts about
              an install, and for a host they are already on the Hosts screen -
              which is also the only screen that can do anything about either.
              Left out rather than fetched again here, because the one thing
              this card must never do is show this machine's answers under
              another machine's heading. */}
          {local !== undefined && (
            <>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Database</dt>
                <dd data-selectable className="break-words font-mono">
                  <Breakable text={local.databasePath} />
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Version</dt>
                <dd className="font-mono">
                  {local.version}
                  {!local.packaged && ' (dev)'}
                </dd>
              </div>
            </>
          )}
        </dl>

        <p className="mt-4 text-xs text-muted-foreground">
          The agent runs the server as a child process over stdio — there is no port and no login.
          It shares this database, so changes show up here immediately, and it keeps working when
          GitWarren is closed.
        </p>
      </Card>
    </div>
  )
}
