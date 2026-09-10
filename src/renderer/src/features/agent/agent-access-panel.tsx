/**
 * Shows the user how to point an agent at GitWarren.
 *
 * Since M2 that is one sentence rather than a JSON snippet. The app maintains a
 * launcher at `~/.gitwarren/bin/gitwarren-mcp`, the same path on every machine
 * and after every update, so what the user needs to hand over is a command -
 * and an agent applies a command to its own configuration format far more
 * reliably than a person copies JSON into the right file. The per-harness
 * snippet is still here, behind a disclosure, for anyone who would rather do it
 * by hand.
 */
import { useState } from 'react'
import useSWR from 'swr'
import { Check, ChevronDown, Copy, Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Card } from '@/components/ui/card'
import { api, CACHE_KEYS } from '@/lib/api'
import { LINK_SERVER_PORT } from '@shared/link-port'
import { cn } from '@/lib/utils'

/**
 * A copy button that says it worked.
 *
 * Two of them on this panel now - the prompt and the snippet - which is exactly
 * when a local `copied` flag stops being adequate: one component per button,
 * each with its own.
 */
function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <Tooltip label={copied ? 'Copied' : label}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void copy()}
        aria-label={label}
        className="absolute right-1.5 top-1.5"
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </Tooltip>
  )
}

export function AgentAccessPanel() {
  const { data: info } = useSWR(CACHE_KEYS.appInfo, () => api.system.appInfo())
  const [open, setOpen] = useState(false)
  const [manual, setManual] = useState(false)

  if (!info) return null

  /**
   * The sentence. Written to the agent rather than about it: it names the
   * command, says what protocol it speaks, and asks for a check afterwards -
   * because an agent that registers a server and never calls it will report
   * success from a config file it has not tested.
   */
  const prompt =
    `Set up the GitWarren MCP server for yourself. It speaks MCP over stdio and is started ` +
    `with the command ${info.mcp.command} (no arguments, no environment). Register it under ` +
    `the name "gitwarren" in your own MCP configuration, then call its agent_identity tool ` +
    `to confirm it works.`

  const snippet = JSON.stringify(
    { mcpServers: { gitwarren: { command: info.mcp.command, args: info.mcp.args } } },
    null,
    2
  )

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/50"
      >
        <Plug className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1">
          <span className="block text-sm font-medium">Agent access</span>
          <span className="block text-xs text-muted-foreground">
            Let a local AI agent manage these repositories over MCP
          </span>
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <div className="border-t border-border p-4">
          {info.mcp.note && (
            <p className="mb-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
              {info.mcp.note}
            </p>
          )}

          {info.linkPort === null && (
            <p className="mb-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
              Another program is using port {LINK_SERVER_PORT}, so links an agent hands you will
              not open GitWarren until it lets go. Everything else works, and the links
              themselves are still correct — they name the same port on every machine.
            </p>
          )}

          {!info.mcp.available && (
            <p className="mb-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
              The MCP server has not been built yet. Run <code>npm run build</code> first — in dev
              it is built alongside the app.
            </p>
          )}

          <p className="mb-2 text-xs text-muted-foreground">
            Paste this into whichever agent you use — it will configure itself:
          </p>

          <div className="relative">
            <p
              data-selectable
              className="rounded-md bg-muted p-3 pr-12 text-xs leading-relaxed [overflow-wrap:anywhere]"
            >
              {prompt}
            </p>
            <CopyButton label="Copy this prompt" text={prompt} />
          </div>

          <button
            type="button"
            onClick={() => setManual((value) => !value)}
            aria-expanded={manual}
            className="mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn('size-3 transition-transform', manual && 'rotate-180')} />
            Configure by hand
          </button>

          {manual && (
            <div className="mt-2">
              <p className="mb-2 text-xs text-muted-foreground">
                For Claude Code, Cursor, Windsurf and Gemini CLI. Codex wants the same command
                under <code>[mcp_servers.gitwarren]</code> in TOML; VS Code calls the object{' '}
                <code>servers</code>.
              </p>
              <div className="relative">
                <pre
                  data-selectable
                  className="max-h-64 overflow-auto rounded-md bg-muted p-3 pr-12 font-mono text-[11px] leading-relaxed"
                >
                  {snippet}
                </pre>
                <CopyButton label="Copy this configuration" text={snippet} />
              </div>
            </div>
          )}

          <dl className="mt-4 space-y-1.5 text-xs">
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

          <p className="mt-3 text-xs text-muted-foreground">
            The agent runs the server as a child process over stdio — there is no port and no
            login. It shares this database, so changes show up here immediately, and it keeps
            working when GitWarren is closed.
          </p>
        </div>
      )}
    </Card>
  )
}
