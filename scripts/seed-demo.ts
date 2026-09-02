/**
 * Seed a throwaway database with demo content for screenshots.
 *
 * Everything is written through the same services the app and the MCP server
 * use, so the result is data the app could genuinely have produced - anchors
 * are captured against the real diff, repository paths go through the same
 * canonicalisation, and agent comments carry the attribution an MCP session
 * would have stamped on them.
 *
 * Point it at a scratch directory; it refuses to touch a database that already
 * has anything in it, so a mistyped GITWARREN_DATA_DIR cannot overwrite real
 * work.
 *
 *   GITWARREN_DATA_DIR=/tmp/gw-demo npx tsx scripts/seed-demo.ts
 */
import { eq, sql } from 'drizzle-orm'
import { getDatabase } from '../src/core/db/client.js'
import { comments, commentThreads, repositories, reviews } from '../src/core/db/schema.js'
import { commentsService } from '../src/core/services/comments.js'
import { repositoriesService } from '../src/core/services/repositories.js'
import { reviewsService } from '../src/core/services/reviews.js'
import { HUMAN_AUTHOR, type CommentAuthor } from '../src/shared/actors.js'
import type { ReviewDiff } from '../src/shared/git.js'

/** Where the demo repositories were created. Overridable for a different machine. */
const DEMO_ROOT = process.env.DEMO_REPO_ROOT ?? `${process.env.HOME}/github.com/klarluft`

/**
 * A Claude Code session, as the MCP handshake would describe one. The session
 * id is fixed rather than random so re-running the seed produces byte-identical
 * screenshots.
 */
const CLAUDE: CommentAuthor = {
  kind: 'agent',
  name: 'Claude Code',
  label: 'shortcuts-review',
  session: 'a3f9c1e8'
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Timestamps are written relative to now, so the screenshots never go stale. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace('Z', 'Z')
}

/**
 * Find a head-side line number by the text on it.
 *
 * Comments are placed by content rather than by hard-coded line numbers so the
 * seed keeps working when the demo branch is rebuilt and everything shifts.
 */
function lineOf(diff: ReviewDiff, path: string, needle: string): number {
  const file = diff.files.find((candidate) => candidate.path === path)
  if (!file) throw new Error(`No file ${path} in the diff. Have: ${diff.files.map((f) => f.path).join(', ')}`)

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newNumber !== null && line.content.includes(needle)) return line.newNumber
    }
  }
  throw new Error(`No line containing ${JSON.stringify(needle)} in ${path}`)
}

async function main(): Promise<void> {
  const db = getDatabase()

  const existing = db.select({ count: sql<number>`count(*)` }).from(repositories).get()
  if ((existing?.count ?? 0) > 0) {
    throw new Error(
      'This database already has repositories in it. Point GITWARREN_DATA_DIR at an empty directory.'
    )
  }

  // ---- repositories -------------------------------------------------------

  const app = await repositoriesService.add({ path: `${DEMO_ROOT}/gitwarren-app` })
  const docs = await repositoriesService.add({ path: `${DEMO_ROOT}/gitwarren-docs` })
  const site = await repositoriesService.add({ path: `${DEMO_ROOT}/klarluft-website` })

  db.update(repositories).set({ createdAt: ago(40 * DAY) }).where(eq(repositories.id, app.id)).run()
  db.update(repositories).set({ createdAt: ago(12 * DAY) }).where(eq(repositories.id, docs.id)).run()
  db.update(repositories).set({ createdAt: ago(5 * DAY) }).where(eq(repositories.id, site.id)).run()

  // ---- reviews ------------------------------------------------------------

  const star = await reviewsService.create({
    repositoryId: app.id,
    title: 'Keyboard shortcuts for review navigation',
    description:
      'Adds a scoped shortcut registry and binds `j`/`k` to step through the changed files, ' +
      "plus `u` to fold uncommitted work in and out.\n\nThe help overlay is still on disk only — I'd " +
      'like a look at the registry shape before I commit it.',
    baseRef: 'main',
    headRef: 'feat/keyboard-shortcuts'
  })

  const fix = await reviewsService.create({
    repositoryId: app.id,
    title: 'Clipped untracked files announce the wrong line count',
    description:
      'The hunk header on a truncated untracked file described the whole file rather than the ' +
      'lines actually rendered, so the anchor resolver counted past the end of the hunk.',
    baseRef: 'main',
    headRef: 'fix/untracked-file-crash'
  })

  const chore = await reviewsService.create({
    repositoryId: app.id,
    title: 'Raise the Node floor to 22.12',
    baseRef: 'main',
    headRef: 'chore/pin-node-22'
  })

  await reviewsService.update({ id: chore.id, status: 'closed' })

  // ---- the discussion on the star review ---------------------------------
  //
  // Read the diff first: every line comment is placed by finding its text in
  // the diff that is actually on screen, uncommitted work included.

  const diff = await reviewsService.diff({ id: star.id, includeUncommitted: true })

  const shortcutsPath = 'src/renderer/src/lib/shortcuts.ts'
  const filesTabPath = 'src/renderer/src/features/reviews/review-files-tab.tsx'
  const helpPath = 'src/renderer/src/features/reviews/shortcut-help.tsx'

  const opening = await commentsService.createThread(
    {
      reviewId: star.id,
      body:
        'Opening this while the help overlay is still uncommitted — the whole point is to look at ' +
        'it before it becomes a commit. `shortcut-help.tsx` is untracked, so it only shows up here ' +
        'with **include uncommitted** on.'
    },
    HUMAN_AUTHOR
  )

  const typing = await commentsService.createThread(
    {
      reviewId: star.id,
      filePath: shortcutsPath,
      line: lineOf(diff, shortcutsPath, 'return tag === '),
      body:
        'This misses one case worth covering: a `<div contenteditable>` inside a shadow root reports ' +
        '`isContentEditable` on the host, not on `event.target`, so a markdown editor that uses one ' +
        'would still get `j` swallowed as navigation.\n\n' +
        'Cheapest fix is to walk `event.composedPath()[0]` instead of `event.target`.'
    },
    CLAUDE
  )

  await commentsService.reply(
    {
      threadId: typing.id,
      body: "Good catch. We don't have a shadow root anywhere today, but the composed path is the same cost — I'll take it."
    },
    HUMAN_AUTHOR
  )

  const uncommitted = await commentsService.createThread(
    {
      reviewId: star.id,
      filePath: filesTabPath,
      line: lineOf(diff, filesTabPath, "key: 'u',"),
      body:
        "`u` is unbound anywhere else, so no conflict — but should this survive a reload? Right now it " +
        'resets to on every time the tab mounts, and the switch beside it is remembered.'
    },
    HUMAN_AUTHOR
  )

  await commentsService.reply(
    {
      threadId: uncommitted.id,
      body:
        '`useStoredFlag` is already imported in this file for exactly that. Swapping the `useState` for it ' +
        'makes the key and the switch agree, and costs one line.'
    },
    CLAUDE
  )

  const rangeThread = await commentsService.createThread(
    {
      reviewId: star.id,
      filePath: helpPath,
      startLine: lineOf(diff, helpPath, 'const SCOPE_TITLES'),
      line: lineOf(diff, helpPath, "conversation: 'Conversation'"),
      body:
        'Worth pulling this map next to the `ShortcutScope` union so adding a scope fails the build ' +
        'until it has a title. `Record` already does half of that — it just needs to live in the same file.'
    },
    CLAUDE
  )

  const resolved = await commentsService.createThread(
    {
      reviewId: star.id,
      filePath: shortcutsPath,
      line: lineOf(diff, shortcutsPath, 'if (event.metaKey'),
      body: 'Should this let `Shift` through? `?` is shift-slash on most layouts.'
    },
    HUMAN_AUTHOR
  )

  await commentsService.reply(
    {
      threadId: resolved.id,
      body:
        "It does — `shiftKey` isn't in the guard, so `?` arrives as `event.key === '?'` and matches " +
        'normally. Only the three modifiers that mean "this is for the OS" bail out.'
    },
    CLAUDE
  )

  await commentsService.setResolved({ threadId: resolved.id, resolved: true }, HUMAN_AUTHOR)

  // ---- one thread on the bug fix, so it is not an empty review ------------

  await commentsService.createThread(
    {
      reviewId: fix.id,
      body:
        'Confirmed against a 6k-line vendored bundle: before this, the header claimed `+1,6021` on a ' +
        'hunk carrying 4000 lines. Anchors on that file were landing about two thousand lines out.'
    },
    HUMAN_AUTHOR
  )

  // ---- backdate the discussion -------------------------------------------
  //
  // Written last so the relative timestamps in the UI read like a conversation
  // that happened over two days rather than one that happened in 40ms.

  const schedule: [number, number][] = [
    [opening.id, 2 * DAY],
    [typing.id, 26 * HOUR],
    [uncommitted.id, 4 * HOUR],
    [rangeThread.id, 3 * HOUR],
    [resolved.id, 22 * HOUR]
  ]

  for (const [threadId, age] of schedule) {
    db.update(commentThreads).set({ createdAt: ago(age), updatedAt: ago(age - HOUR) }).where(eq(commentThreads.id, threadId)).run()

    const rows = db.select().from(comments).where(eq(comments.threadId, threadId)).all()
    rows.forEach((row, index) => {
      const at = ago(age - index * (HOUR / 2))
      db.update(comments).set({ createdAt: at, updatedAt: at }).where(eq(comments.id, row.id)).run()
    })
  }

  db.update(commentThreads)
    .set({ resolvedAt: ago(21 * HOUR), resolvedBy: 'Human' })
    .where(eq(commentThreads.id, resolved.id))
    .run()

  // The reviews are backdated *last*. Every thread created above bumped its
  // review's `updatedAt` to now - that is the whole point of the column - so
  // doing this any earlier would leave three reviews all reading "just now".
  db.update(reviews)
    .set({ createdAt: ago(2 * DAY), updatedAt: ago(3 * HOUR) })
    .where(eq(reviews.id, star.id))
    .run()
  db.update(reviews)
    .set({ createdAt: ago(4 * DAY), updatedAt: ago(19 * HOUR) })
    .where(eq(reviews.id, fix.id))
    .run()
  db.update(reviews)
    .set({ createdAt: ago(9 * DAY), updatedAt: ago(6 * DAY), closedAt: ago(6 * DAY) })
    .where(eq(reviews.id, chore.id))
    .run()

  const counts = await commentsService.counts(star.id)
  console.log(
    `Seeded ${DEMO_ROOT}: 3 repositories, 3 reviews, ${counts.threads} threads ` +
      `(${counts.unresolved} unresolved) on "${star.title}".`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
