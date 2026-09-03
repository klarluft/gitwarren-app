/**
 * The agent's half of the hero video: reply to the newest thread on one file.
 *
 * Written through the same service the MCP server calls, with the same kind of
 * attribution an MCP session would stamp on it, so what appears on screen is a
 * real agent comment rather than a mock-up of one.
 *
 * Started by capture-hero-video.mjs ahead of time; it does nothing until a line
 * arrives on stdin, then replies and exits. That keeps tsx start-up out of the
 * recording.
 *
 *   GITWARREN_DATA_DIR=/tmp/gw-demo DEMO_FILE_PATH=src/x.ts DEMO_REPLY_BODY='…' \
 *     npx tsx scripts/demo-agent-reply.ts
 */
import { and, desc, eq } from 'drizzle-orm'
import { getDatabase } from '../src/core/db/client.js'
import { commentThreads } from '../src/core/db/schema.js'
import { commentsService } from '../src/core/services/comments.js'
import type { CommentAuthor } from '../src/shared/actors.js'

/** The same session the seeded discussion came from. */
const CLAUDE: CommentAuthor = {
  kind: 'agent',
  name: 'Claude Code',
  label: 'shortcuts-review',
  session: 'a3f9c1e8'
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}.`)
  return value
}

const reviewId = Number(process.env.DEMO_REVIEW_ID ?? 1)
const filePath = required('DEMO_FILE_PATH')
const body = required('DEMO_REPLY_BODY')

async function main(): Promise<void> {
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()))

  const db = getDatabase()
  const thread = db
    .select({ id: commentThreads.id })
    .from(commentThreads)
    .where(and(eq(commentThreads.reviewId, reviewId), eq(commentThreads.filePath, filePath)))
    .orderBy(desc(commentThreads.id))
    .get()
  if (!thread) throw new Error(`No thread on ${filePath} in review ${reviewId}`)

  await commentsService.reply({ threadId: thread.id, body }, CLAUDE)
  console.log(`  (agent replied on thread ${thread.id})`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
