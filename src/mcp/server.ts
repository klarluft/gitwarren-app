/**
 * GitWarren's MCP server, spoken over stdio.
 *
 * stdio rather than HTTP on purpose: there is no port to allocate, discover or
 * collide with, and the agent's own process manager controls the lifetime. It
 * runs as a separate OS process from the GUI and reaches the same SQLite file,
 * which is why WAL mode and a busy timeout are set in `core/db/client.ts`.
 *
 * Every tool here is a thin wrapper over a core service using the same zod
 * schemas the UI forms use. There is deliberately no validation in this file -
 * an agent and a human get identical rules because they run identical code.
 *
 * Reviews are exposed as CRUD only. There is no `get_review_diff` and no
 * `list_review_commits`, even though the service can produce both: an agent
 * pointed at these repositories can run `git log` and `git diff` itself, and a
 * tool call returning a second-hand copy would be a lossier version of data it
 * already has. What GitWarren uniquely holds is the discussion attached to
 * those changes, and that is what the comment tools carry.
 *
 * No authentication: this is a local, single-user app, the transport is a pipe
 * owned by the agent the user launched, and there is no network surface.
 *
 * There is, however, *attribution*, which is a different thing. Every comment
 * written through this server is marked as machine-written and named after the
 * client that wrote it, taken from the MCP handshake rather than asked for at
 * call time - so a review with three agents in it reads as a conversation
 * between three participants rather than an undifferentiated pile of "AI".
 * The reasoning is in `identity.ts`.
 *
 * One hard rule: stdout belongs to the protocol. Diagnostics go to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z, type ZodRawShape } from 'zod'
import { closeDatabase } from '../core/db/client.js'
import { getDatabasePath } from '../core/paths.js'
import { commentsService } from '../core/services/comments.js'
import { repositoriesService } from '../core/services/repositories.js'
import { reviewsService } from '../core/services/reviews.js'
import { authorDisplayName, type CommentAuthor } from '../shared/actors.js'
import { AppError } from '../shared/errors.js'
import { agentAuthor, getSessionId, getSessionLabel, setSessionLabel } from './identity.js'
import {
  addRepositoryInputSchema,
  agentLabelSchema,
  createReviewInputSchema,
  createThreadInputSchema,
  getRepositoryInputSchema,
  getReviewInputSchema,
  listCommentsInputSchema,
  listReviewsInputSchema,
  removeCommentInputSchema,
  removeRepositoryInputSchema,
  removeReviewInputSchema,
  replyToThreadInputSchema,
  setThreadResolvedInputSchema,
  updateCommentInputSchema,
  updateRepositoryInputSchema,
  updateReviewInputSchema
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

/**
 * Who this connection is, resolved from the `initialize` handshake.
 *
 * Read per call rather than once at startup: `clientInfo` does not exist until
 * the handshake completes, and caching an `undefined` from before it would cost
 * the agent its name for the life of the process. See `identity.ts` for why the
 * name is taken from the handshake instead of being asked for.
 */
function currentAuthor(): CommentAuthor {
  return agentAuthor(server.server.getClientVersion())
}

/**
 * Every comment-writing tool accepts an optional session label. Supplying it
 * once is enough - it is remembered for the rest of the session, so an agent
 * does not have to repeat itself on every reply.
 */
function withLabel<T extends ZodRawShape>(shape: T): T & { agentLabel: z.ZodOptional<typeof agentLabelSchema> } {
  return { ...shape, agentLabel: agentLabelSchema.optional() }
}

function adoptLabel(input: { agentLabel?: string }): CommentAuthor {
  if (input.agentLabel !== undefined) setSessionLabel(input.agentLabel)
  return currentAuthor()
}

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

server.registerTool(
  'list_reviews',
  {
    title: 'List reviews',
    description:
      'List reviews, newest activity first. Filter with `repositoryId` and/or `status` ' +
      '("open" or "closed"); omit both to list every review across all tracked repositories. ' +
      'A review records the two refs being compared, not the commits they resolved to - ' +
      'read the repository with git to see the actual changes.',
    inputSchema: listReviewsInputSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  (input) => run(() => reviewsService.list(input))
)

server.registerTool(
  'get_review',
  {
    title: 'Get review',
    description:
      'Fetch one review by id, with the repository it belongs to attached (including the ' +
      'repository path, so the changes can be inspected with git directly).',
    inputSchema: getReviewInputSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  (input) => run(() => reviewsService.get(input))
)

server.registerTool(
  'create_review',
  {
    title: 'Create review',
    description:
      'Open a review comparing two refs in a tracked repository. `baseRef` is what the changes ' +
      'are measured against (usually the trunk) and `headRef` is the branch under review; the ' +
      'diff is taken from their merge base, like a pull request. Both refs must exist and share ' +
      'history, or the call fails with INVALID_INPUT. `title` defaults to "<head> into <base>". ' +
      'If the head branch is checked out in a worktree, its uncommitted changes are part of the ' +
      'review as well - a review can be opened on work that has never been committed.',
    inputSchema: createReviewInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  (input) => run(() => reviewsService.create(input))
)

server.registerTool(
  'update_review',
  {
    title: 'Update review',
    description:
      'Change a review\'s title, description or endpoints, or set its `status` to "closed" or ' +
      '"open" again. Provide at least one field. New refs are validated exactly as they are on ' +
      'creation.',
    inputSchema: updateReviewInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (input) => run(() => reviewsService.update(input))
)

server.registerTool(
  'remove_review',
  {
    title: 'Remove review',
    description:
      'Delete a review. This removes only the review record - no branch, commit or file in the ' +
      'repository is touched. To file a finished review away without deleting it, set its status ' +
      'to "closed" instead.',
    inputSchema: removeReviewInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  (input) => run(() => reviewsService.remove(input))
)

/* -------------------------------------------------------------------------- */
/* Comments - the part of a review only GitWarren holds                       */
/* -------------------------------------------------------------------------- */

server.registerTool(
  'agent_identity',
  {
    title: 'Agent identity',
    description:
      'Show how comments from this session will be attributed, and optionally set a label for ' +
      'the session. The tool name ("Claude Code", "Codex", ...) is taken from the MCP handshake ' +
      'and cannot be changed - it is what makes attribution consistent across sessions. `label` ' +
      'is a short handle for *this* session ("auth-refactor"), worth setting when more than one ' +
      'agent is working the same review; it is remembered until this server process exits.',
    inputSchema: { label: agentLabelSchema.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (input) =>
    run(() => {
      if (input.label !== undefined) setSessionLabel(input.label)
      const author = currentAuthor()
      return Promise.resolve({
        name: author.name,
        label: getSessionLabel(),
        session: getSessionId(),
        displayName: authorDisplayName(author)
      })
    })
)

server.registerTool(
  'list_review_comments',
  {
    title: 'List review comments',
    description:
      'Every discussion on a review: review-level threads and line comments alike, each with its ' +
      'full message history and who wrote each message. Line threads also carry an `anchor` ' +
      'saying where they land in the diff as it stands right now - "anchored" (the line is ' +
      'unchanged), "moved" (the code shifted and `anchor.line` is its current line) or "outdated" ' +
      '(the line is no longer in the diff, so the comment may be about code that has since been ' +
      'rewritten). Check the anchor before acting on a line comment. An outdated one still ' +
      'carries `anchorSnapshot`, the code as it read when the comment was written, which is how ' +
      'to tell what was being objected to before it was rewritten.',
    inputSchema: listCommentsInputSchema.shape,
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  (input) => run(() => commentsService.listAnchored(input))
)

server.registerTool(
  'add_review_comment',
  {
    title: 'Add review comment',
    description:
      'Start a new discussion on a review. Omit `filePath` and `line` for a comment on the ' +
      'review as a whole; give both to attach it to a line, the way a pull-request review ' +
      'comment works. `side` picks which side of the diff `line` counts on - "head" (the ' +
      'default) for the code as it will be, "base" to remark on a line the change removed. ' +
      'The line is not required to be part of the diff: the comment is kept either way, and the ' +
      'returned thread says whether it could be anchored to a visible line. ' +
      'Comments are attributed automatically from the MCP handshake - see `agent_identity`.',
    inputSchema: withLabel(createThreadInputSchema.shape),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  (input) => run(() => commentsService.createThread(input, adoptLabel(input)))
)

server.registerTool(
  'reply_to_review_comment',
  {
    title: 'Reply to a review comment',
    description:
      'Add a message to an existing thread. Use this rather than opening a new thread when ' +
      'responding to something someone already raised, so the discussion stays in one place. ' +
      'Thread ids come from `list_review_comments`.',
    inputSchema: withLabel(replyToThreadInputSchema.shape),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  (input) => run(() => commentsService.reply(input, adoptLabel(input)))
)

server.registerTool(
  'resolve_review_comment',
  {
    title: 'Resolve or reopen a thread',
    description:
      'Mark a discussion settled, or reopen one. Set `resolved` to true once the point has been ' +
      'addressed, false to bring it back. Resolving records who did it; it never deletes the ' +
      'messages, which stay readable.',
    inputSchema: setThreadResolvedInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (input) => run(() => commentsService.setResolved(input, currentAuthor()))
)

server.registerTool(
  'update_review_comment',
  {
    title: 'Edit a comment',
    description:
      'Replace the text of one message. An agent can only edit messages written by its own tool - ' +
      'correcting yourself is expected, rewriting someone else\'s review is not.',
    inputSchema: updateCommentInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  (input) => run(() => commentsService.update(input, currentAuthor()))
)

server.registerTool(
  'delete_review_comment',
  {
    title: 'Delete a comment',
    description:
      'Delete one message. If it was the only message in its thread, the thread goes with it. ' +
      'As with editing, an agent can only delete messages written by its own tool.',
    inputSchema: removeCommentInputSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  (input) => run(() => commentsService.remove(input, currentAuthor()))
)

async function main(): Promise<void> {
  // Set before connecting: the handshake can land the moment the transport is
  // up, and a listener attached afterwards would miss it.
  server.server.oninitialized = () => {
    // Printed so the user can see, in the agent's own logs, the name comments
    // from this session will appear under.
    console.error(
      `[gitwarren-mcp] comments from this session: ${authorDisplayName(currentAuthor())}`
    )
  }

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
