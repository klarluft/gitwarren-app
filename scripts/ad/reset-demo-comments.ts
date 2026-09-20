/**
 * Take back what a take of `capture-ad.mjs` wrote, so the next take starts
 * from the seed.
 *
 * Two beats post a comment and have the agent answer it. Reseeding would do,
 * but `serve` holds the database open and Chrome holds a token for that
 * serve, so a reseed is three restarts. Removing the threads those beats
 * created is none: they are the ones whose opening comment is one the script
 * types, and nothing in the seed says those words.
 *
 *   GITWARREN_DATA_DIR=<seeded dir> npx tsx scripts/ad/reset-demo-comments.ts
 */
import { commentsService } from '../../src/core/services/comments.js'
import { HUMAN_AUTHOR, type CommentAuthor } from '../../src/shared/actors.js'

const REVIEW_ID = Number(process.env.DEMO_REVIEW_ID ?? 1)

/** The opening comments `capture-ad.mjs` types; keep in step with it. */
const TYPED = [
  'Does this need its own Escape handling, or does the dialog already close on it?',
  'The registry declares a conversation scope and nothing in here binds it. Intended?'
]

/** The same session `demo-agent-reply.ts` answers as. */
const CLAUDE: CommentAuthor = {
  kind: 'agent',
  name: 'Claude Code',
  label: 'shortcuts-review',
  session: 'a3f9c1e8'
}

async function main(): Promise<void> {
  const threads = await commentsService.list({ reviewId: REVIEW_ID })
  let removed = 0
  for (const thread of threads) {
    const [first, ...rest] = thread.comments
    if (!first || !TYPED.includes(first.body)) continue
    // Replies first, the root last: removing the last comment removes the thread.
    for (const comment of [...rest.reverse(), first]) {
      const actor = comment.author.kind === 'agent' ? CLAUDE : HUMAN_AUTHOR
      await commentsService.remove({ id: comment.id }, actor)
    }
    removed += 1
  }
  console.log(`Removed ${removed} thread(s) written by the ad captures.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
