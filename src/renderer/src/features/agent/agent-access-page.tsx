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
 */
import { useRef, useState, type RefObject } from 'react'
import useSWR from 'swr'
import { AlertTriangle, ArrowLeft, Check, ChevronDown, Copy, Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs'
import { api, CACHE_KEYS } from '@/lib/api'
import { navigate } from '@/lib/router'
import { LINK_SERVER_PORT } from '@shared/link-port'
import {
  agentConfigSnippets,
  agentSetupPrompt,
  type AgentConfigSnippet
} from '@shared/agent-setup'
import { cn } from '@/lib/utils'

/**
 * A copy button that says it worked, and says so when it did not.
 *
 * Four of them on this page now - the prompt and one per format - which is
 * exactly when a local `copied` flag stops being adequate: one component per
 * button, each with its own.
 *
 * The refusal path is not theoretical and is why `source` is here. A clipboard
 * write needs a focused document and a permission the browser may simply not
 * give; when it is refused, `writeText` rejects and a button that only ever
 * sets `copied` on success leaves the user pressing it again at a page that
 * does nothing. So a failure selects the text instead - the same thing the
 * person was about to do by hand, done for them, with the keystroke named.
 */
function CopyButton({
  label,
  text,
  source,
  className,
  children
}: {
  label: string
  text: string
  /** The element holding `text`, selected when the clipboard says no. */
  source: RefObject<HTMLElement | null>
  className?: string
  children?: React.ReactNode
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'select'>('idle')

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
      setTimeout(() => setState('idle'), 1800)
    } catch {
      const element = source.current
      if (element) {
        const range = document.createRange()
        range.selectNodeContents(element)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
      }
      // Left standing rather than timed out: it is an instruction now, and it
      // stays true until the next press.
      setState('select')
    }
  }

  const icon = state === 'copied' ? <Check className="text-success" /> : <Copy />
  const said = state === 'copied' ? 'Copied' : state === 'select' ? 'Selected — press copy' : null

  // Two shapes, one behaviour: the prompt's is a labelled button because it is
  // the action the page exists for, and a snippet's is the icon in the corner.
  if (children !== undefined) {
    return (
      <Button onClick={() => void copy()} className={className}>
        {icon}
        {said ?? children}
      </Button>
    )
  }

  return (
    <Tooltip label={said ?? label}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void copy()}
        aria-label={label}
        className={cn('absolute right-1.5 top-1.5', className)}
      >
        {icon}
      </Button>
    </Tooltip>
  )
}

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

export function AgentAccessPage() {
  const { data: info, isLoading } = useSWR(CACHE_KEYS.appInfo, () => api.system.appInfo())
  const [manual, setManual] = useState(false)
  const promptRef = useRef<HTMLParagraphElement>(null)

  if (isLoading || !info) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading agent access">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  const prompt = agentSetupPrompt(info.mcp)
  const snippets = agentConfigSnippets(info.mcp)
  // Only worth showing when it is not the launcher again. In the app it is
  // Electron-run-as-node plus a script inside the install; in a daemon there is
  // nothing behind the launcher and repeating it would read as a second option.
  const direct = info.mcp.direct.command === info.mcp.command ? null : info.mcp.direct

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 mb-2 text-muted-foreground"
          onClick={() => navigate({ name: 'repositories' })}
        >
          <ArrowLeft />
          Repositories
        </Button>

        <div className="flex items-center gap-2">
          <Plug className="size-5 shrink-0 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">Agent access</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Give an AI agent one sentence and it will configure itself to read and write these
          reviews over MCP.
        </p>
      </div>

      {/* The lead. Everything else on the page is a footnote to it. */}
      <Card className="p-4">
        <p className="text-sm font-medium">Paste this into whichever agent you use</p>
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

      {(info.mcp.note || !info.mcp.available || info.linkPort === null) && (
        <div className="flex flex-col gap-2">
          {/* The install's own words first. Each shell knows a different reason
              the launcher might not be there and a different way to fix it -
              `npm run build` in a checkout, `gitwarren service install` on a
              machine with no app - and neither of them is this page's to guess. */}
          {info.mcp.note ? (
            <Warning>{info.mcp.note}</Warning>
          ) : (
            !info.mcp.available && (
              <Warning>
                The MCP server is not on this machine yet, so the command above does not exist
                until it is. The prompt itself will not change.
              </Warning>
            )
          )}

          {info.linkPort === null && (
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
                and cannot select is worse than one that takes two lines. */}
            <dd data-selectable className="font-mono [overflow-wrap:anywhere]">
              {info.mcp.command}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-muted-foreground">Database</dt>
            <dd data-selectable className="font-mono [overflow-wrap:anywhere]">
              {info.databasePath}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-muted-foreground">Version</dt>
            <dd className="font-mono">
              {info.version}
              {!info.packaged && ' (dev)'}
            </dd>
          </div>
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
