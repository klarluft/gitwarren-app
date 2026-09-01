/**
 * Shows the user exactly how to point an agent at this install's MCP server.
 *
 * The paths differ per platform and per install location, so printing them in
 * the README would be a guess. They are computed by the main process for the
 * running app and copied straight into the agent's config.
 */
import { useState } from 'react'
import useSWR from 'swr'
import { Check, ChevronDown, Copy, Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Card } from '@/components/ui/card'
import { api, CACHE_KEYS } from '@/lib/api'
import { cn } from '@/lib/utils'

export function AgentAccessPanel() {
  const { data: info } = useSWR(CACHE_KEYS.appInfo, () => api.system.appInfo())
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!info) return null

  const snippet = JSON.stringify(
    {
      mcpServers: {
        gitwarren: { command: info.mcp.command, args: info.mcp.args, env: info.mcp.env }
      }
    },
    null,
    2
  )

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(snippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

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

          {!info.mcp.available && (
            <p className="mb-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
              The MCP server has not been built yet. Run <code>npm run build</code> first — in dev
              it is built alongside the app.
            </p>
          )}

          <p className="mb-2 text-xs text-muted-foreground">
            Add this to your agent&rsquo;s MCP configuration:
          </p>

          <div className="relative">
            <pre
              data-selectable
              className="max-h-64 overflow-auto rounded-md bg-muted p-3 pr-12 font-mono text-[11px] leading-relaxed"
            >
              {snippet}
            </pre>
            <Tooltip label={copied ? 'Copied' : 'Copy this configuration'}>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void copy()}
                className="absolute right-1.5 top-1.5"
                aria-label="Copy MCP configuration"
              >
                {copied ? <Check className="text-success" /> : <Copy />}
              </Button>
            </Tooltip>
          </div>

          <dl className="mt-4 space-y-1.5 text-xs">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">Database</dt>
              <dd data-selectable className="truncate font-mono" title={info.databasePath}>
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
            login. It shares this database, so changes show up here immediately.
          </p>
        </div>
      )}
    </Card>
  )
}
