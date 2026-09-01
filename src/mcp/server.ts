/**
 * GitWarren's MCP server, spoken over stdio.
 *
 * stdio rather than HTTP on purpose: there is no port to allocate, discover or
 * collide with, and the agent's own process manager controls the lifetime. It
 * runs as a separate OS process from the GUI and reaches the same SQLite file,
 * which is why WAL mode and a busy timeout are set in `core/db/client.ts`.
 *
 * Every tool here is a thin wrapper over `repositoriesService` using the same
 * zod schemas the UI forms use. There is deliberately no validation in this
 * file - an agent and a human get identical rules because they run identical
 * code.
 *
 * No authentication: this is a local, single-user app, the transport is a pipe
 * owned by the agent the user launched, and there is no network surface.
 *
 * One hard rule: stdout belongs to the protocol. Diagnostics go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { closeDatabase } from '../core/db/client.js'
import { getDatabasePath } from '../core/paths.js'
import { repositoriesService } from '../core/services/repositories.js'
import { AppError } from '../shared/errors.js'
import {
  addRepositoryInputSchema,
  getRepositoryInputSchema,
  removeRepositoryInputSchema,
  updateRepositoryInputSchema
} from '../shared/schemas.js'

const VERSION = '0.1.0'

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

/**
 * Domain errors are reported as tool errors carrying their code, so an agent
 * can tell "already tracked" apart from "not a git repository" and react,
 * rather than having to pattern-match on prose.
 */
function fail(error: unknown): CallToolResult {
  const appError = AppError.from(error)
  return {
    isError: true,
    content: [{ type: 'text', text: `${appError.code}: ${appError.message}` }]
  }
}

async function run<T>(operation: () => Promise<T>): Promise<CallToolResult> {
  try {
    return ok(await operation())
  } catch (error) {
    return fail(error)
  }
}

const server = new McpServer({ name: 'gitwarren', version: VERSION })

server.registerTool(
  'list_repositories',
  {
    title: 'List repositories',
    description:
      'List every git repository tracked in GitWarren, each with its live git state ' +
      '(whether the folder still exists, whether it is still a repository, and the current branch). ' +
      'Git state is read fresh on every call and is never cached.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  () => run(() => repositoriesService.list())
)

server.registerTool(
  'get_repository',
  {
    title: 'Get repository',
    description: 'Fetch one tracked repository by id, with its live git state.',
    inputSchema: getRepositoryInputSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  (input) => run(() => repositoriesService.get(input))
)

server.registerTool(
  'add_repository',
  {
    title: 'Add repository',
    description:
      'Start tracking a git repository. `path` may be any directory inside the working tree - ' +
      'it is resolved to the repository root before being stored, so the same repository cannot ' +
      'be added twice under two different paths. `name` defaults to the folder name. ' +
      'Fails with NOT_A_GIT_REPOSITORY if the path is not inside a git repository.',
    inputSchema: addRepositoryInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  (input) => run(() => repositoriesService.add(input))
)

server.registerTool(
  'update_repository',
  {
    title: 'Update repository',
    description:
      'Rename a tracked repository, or repoint it at a moved working copy. ' +
      'Provide at least one of `name` or `path`. A new path is validated and resolved exactly ' +
      'as it is when adding.',
    inputSchema: updateRepositoryInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (input) => run(() => repositoriesService.update(input))
)

server.registerTool(
  'remove_repository',
  {
    title: 'Remove repository',
    description:
      'Stop tracking a repository. This only removes it from GitWarren - the working copy on ' +
      'disk is never touched.',
    inputSchema: removeRepositoryInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  (input) => run(() => repositoriesService.remove(input))
)

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[gitwarren-mcp] ready (database: ${getDatabasePath()})`)
}

function shutdown(): void {
  closeDatabase()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((error) => {
  console.error('[gitwarren-mcp] failed to start:', error)
  process.exit(1)
})
