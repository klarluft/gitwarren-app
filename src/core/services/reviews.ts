/**
 * The review service: the one implementation of every review operation.
 *
 * Same contract as `repositories.ts` - every function re-parses its own input
 * with the shared zod schema rather than trusting the caller, so the IPC layer
 * and the MCP tools cannot disagree about what a valid review is.
 *
 * The split worth noticing here is between the CRUD half and the read-only git
 * half. `list`/`get`/`create`/`update`/`remove` write durable rows and are
 * exposed to agents over MCP. `commits`/`diff` only read git, and are
 * deliberately *not* exposed: an agent with access to the repository can run
 * `git log` and `git diff` itself, and a second, lossier copy of that data
 * behind a tool call would be strictly worse than the real thing. What agents
 * will need from GitWarren is the discussion around the code, which is what the
 * conversation tab will hold.
 */
import { and, desc, eq } from 'drizzle-orm'
import { getDatabase } from '../db/client.js'
import { repositories, reviews, type RepositoryRow, type ReviewRow } from '../db/schema.js'
import {
  readReviewCommits,
  readReviewDiff,
  readReviewFile,
  resolveCompare,
  resolveReviewFilePath
} from '../git-compare.js'
import { AppError } from '../../shared/errors.js'
import { parseWithSchema as parse } from '../../shared/validation.js'
import {
  createReviewInputSchema,
  getReviewInputSchema,
  listReviewsInputSchema,
  removeReviewInputSchema,
  reviewCommitsInputSchema,
  reviewDiffInputSchema,
  reviewFileInputSchema,
  updateReviewInputSchema,
  type Review,
  type ReviewWithRepository
} from '../../shared/schemas.js'
import type { FileContent, ReviewCommits, ReviewDiff } from '../../shared/git.js'

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    title: row.title,
    description: row.description,
    baseRef: row.baseRef,
    headRef: row.headRef,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function requireReview(id: number): ReviewRow {
  const row = getDatabase().select().from(reviews).where(eq(reviews.id, id)).get()
  if (!row) throw new AppError('NOT_FOUND', `No review with id ${id}.`)
  return row
}

function requireRepository(id: number): RepositoryRow {
  const row = getDatabase().select().from(repositories).where(eq(repositories.id, id)).get()
  if (!row) throw new AppError('NOT_FOUND', `No repository with id ${id}.`)
  return row
}

/**
 * Check that two refs can actually be compared before a review is stored.
 *
 * A review whose refs do not resolve is not an error later - branches get
 * deleted and the screen says so - but creating one that was never valid is
 * just a typo the user should see immediately, attached to the field that
 * caused it.
 */
async function assertComparable(
  repositoryPath: string,
  baseRef: string,
  headRef: string
): Promise<void> {
  const compare = await resolveCompare(repositoryPath, baseRef, headRef)

  if (compare.base.error || compare.head.error) {
    const fieldErrors: Record<string, string[]> = {}
    if (compare.base.error) fieldErrors.baseRef = [`No such branch, tag or commit: ${baseRef}`]
    if (compare.head.error) fieldErrors.headRef = [`No such branch, tag or commit: ${headRef}`]
    const message =
      fieldErrors.baseRef?.[0] ?? fieldErrors.headRef?.[0] ?? 'That ref does not exist.'
    throw new AppError('INVALID_INPUT', message, fieldErrors)
  }

  if (compare.error) {
    // The folder vanished, or the two refs share no history.
    const code = compare.error.startsWith('Folder') ? 'PATH_NOT_FOUND' : 'INVALID_INPUT'
    throw new AppError(code, compare.error, { headRef: [compare.error] })
  }
}

export const reviewsService = {
  /** Reviews, newest activity first. Filterable by repository and status. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async list(input: unknown): Promise<Review[]> {
    const { repositoryId, status } = parse(listReviewsInputSchema, input)

    const filters = [
      repositoryId === undefined ? undefined : eq(reviews.repositoryId, repositoryId),
      status === undefined ? undefined : eq(reviews.status, status)
    ].filter((filter) => filter !== undefined)

    return getDatabase()
      .select()
      .from(reviews)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(reviews.updatedAt))
      .all()
      .map(toReview)
  },

  /** One review, with its repository attached - the detail screen needs both. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(input: unknown): Promise<ReviewWithRepository> {
    const { id } = parse(getReviewInputSchema, input)
    const row = requireReview(id)
    const repository = requireRepository(row.repositoryId)

    return {
      ...toReview(row),
      repository: {
        id: repository.id,
        path: repository.path,
        name: repository.name,
        createdAt: repository.createdAt,
        updatedAt: repository.updatedAt
      }
    }
  },

  async create(input: unknown): Promise<Review> {
    const { repositoryId, title, description, baseRef, headRef } = parse(
      createReviewInputSchema,
      input
    )
    const repository = requireRepository(repositoryId)
    await assertComparable(repository.path, baseRef, headRef)

    const timestamp = nowIso()
    const row = getDatabase()
      .insert(reviews)
      .values({
        repositoryId,
        title: title ?? `${headRef} into ${baseRef}`,
        description: description ?? '',
        baseRef,
        headRef,
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
        closedAt: null
      })
      .returning()
      .get()

    return toReview(row)
  },

  /** Edit a review's metadata, repoint its endpoints, or open/close it. */
  async update(input: unknown): Promise<Review> {
    const { id, title, description, baseRef, headRef, status } = parse(
      updateReviewInputSchema,
      input
    )
    const current = requireReview(id)

    const nextBase = baseRef ?? current.baseRef
    const nextHead = headRef ?? current.headRef
    if (nextBase === nextHead) {
      throw new AppError('INVALID_INPUT', 'Pick two different refs.', {
        headRef: ['Pick two different refs - a ref compared against itself is empty.']
      })
    }
    if (baseRef !== undefined || headRef !== undefined) {
      await assertComparable(requireRepository(current.repositoryId).path, nextBase, nextHead)
    }

    const changes: Partial<ReviewRow> = { updatedAt: nowIso() }
    if (title !== undefined) changes.title = title
    if (description !== undefined) changes.description = description
    if (baseRef !== undefined) changes.baseRef = baseRef
    if (headRef !== undefined) changes.headRef = headRef
    if (status !== undefined && status !== current.status) {
      changes.status = status
      // Kept in step with the status rather than left behind as a stale date.
      changes.closedAt = status === 'closed' ? nowIso() : null
    }

    const row = getDatabase().update(reviews).set(changes).where(eq(reviews.id, id)).returning().get()
    if (!row) throw new AppError('NOT_FOUND', `No review with id ${id}.`)
    return toReview(row)
  },

  /** Delete a review. Nothing in the repository is touched. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async remove(input: unknown): Promise<{ id: number }> {
    const { id } = parse(removeReviewInputSchema, input)
    const row = getDatabase().delete(reviews).where(eq(reviews.id, id)).returning().get()
    if (!row) throw new AppError('NOT_FOUND', `No review with id ${id}.`)
    return { id: row.id }
  },

  /**
   * The commits on head that base does not have, plus the uncommitted state of
   * whichever worktree currently holds the head branch.
   */
  async commits(input: unknown): Promise<ReviewCommits> {
    const { id } = parse(reviewCommitsInputSchema, input)
    const row = requireReview(id)
    const repository = requireRepository(row.repositoryId)
    return readReviewCommits(repository.path, row.baseRef, row.headRef)
  },

  /** The merge-base diff, optionally including uncommitted work. */
  async diff(input: unknown): Promise<ReviewDiff> {
    const { id, includeUncommitted } = parse(reviewDiffInputSchema, input)
    const row = requireReview(id)
    const repository = requireRepository(row.repositoryId)
    return readReviewDiff(repository.path, row.baseRef, row.headRef, { includeUncommitted })
  },

  /**
   * One file's head-side text, so the UI can expand the lines the diff hid.
   *
   * Read against the same version of the file the diff was taken from, which is
   * what `includeUncommitted` selects - expanded context from the other version
   * would silently disagree with the hunks it sits between.
   */
  async file(input: unknown): Promise<FileContent> {
    const { id, path, includeUncommitted } = parse(reviewFileInputSchema, input)
    const row = requireReview(id)
    const repository = requireRepository(row.repositoryId)
    return readReviewFile(repository.path, row.baseRef, row.headRef, path, { includeUncommitted })
  },

  /**
   * Where a file of this review lives on disk.
   *
   * The renderer has no filesystem and no path module, so it cannot join the
   * two halves itself - and it should not have to guess whether the head is
   * checked out somewhere other than the repository path.
   */
  async absolutePath(input: unknown): Promise<string> {
    const { id, path, includeUncommitted } = parse(reviewFileInputSchema, input)
    const row = requireReview(id)
    const repository = requireRepository(row.repositoryId)
    return resolveReviewFilePath(repository.path, row.baseRef, row.headRef, path, {
      includeUncommitted
    })
  }
}

export type ReviewsService = typeof reviewsService
