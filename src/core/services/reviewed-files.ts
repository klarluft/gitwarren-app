/**
 * The reviewed-files service: which files someone has ticked off, and against
 * which version of them.
 *
 * Same contract as the other services - every function re-parses its own input
 * with the shared zod schema rather than trusting the caller.
 *
 * Deliberately thin. This service stores and returns digests; it never decides
 * whether a mark is still valid. That comparison belongs to whoever is looking
 * at a diff, because only they know which diff that is - the "include
 * uncommitted" switch means the same review has two of them, and a file can be
 * up to date in one and stale in the other. See `shared/diff-digest.ts`.
 */
import { and, eq } from 'drizzle-orm'
import { getDatabase } from '../db/client.js'
import { reviewedFiles, reviews, type ReviewedFileRow } from '../db/schema.js'
import { AppError } from '../../shared/errors.js'
import { parseWithSchema as parse } from '../../shared/validation.js'
import {
  listReviewedFilesInputSchema,
  setFileReviewedInputSchema,
  type ReviewedFile
} from '../../shared/schemas.js'

function toReviewedFile(row: ReviewedFileRow): ReviewedFile {
  return {
    reviewId: row.reviewId,
    filePath: row.filePath,
    contentDigest: row.contentDigest,
    reviewedAt: row.reviewedAt
  }
}

function requireReview(id: number): void {
  const row = getDatabase().select({ id: reviews.id }).from(reviews).where(eq(reviews.id, id)).get()
  if (!row) throw new AppError('NOT_FOUND', `No review with id ${id}.`)
}

export const reviewedFilesService = {
  /** Every mark on a review. Small enough to hand over whole - one per file. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async list(input: unknown): Promise<ReviewedFile[]> {
    const { reviewId } = parse(listReviewedFilesInputSchema, input)
    requireReview(reviewId)

    return getDatabase()
      .select()
      .from(reviewedFiles)
      .where(eq(reviewedFiles.reviewId, reviewId))
      .all()
      .map(toReviewedFile)
  },

  /**
   * Tick a file off against a digest, or clear the tick when given null.
   *
   * Re-marking an already-marked file overwrites the digest and the timestamp
   * rather than failing: that is what happens every time a file changes and is
   * read again, which is the ordinary case rather than an edge one.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async setReviewed(input: unknown): Promise<ReviewedFile | null> {
    const { reviewId, filePath, contentDigest } = parse(setFileReviewedInputSchema, input)
    requireReview(reviewId)
    const db = getDatabase()

    if (contentDigest === null) {
      db.delete(reviewedFiles)
        .where(and(eq(reviewedFiles.reviewId, reviewId), eq(reviewedFiles.filePath, filePath)))
        .run()
      return null
    }

    const reviewedAt = new Date().toISOString()
    const row = db
      .insert(reviewedFiles)
      .values({ reviewId, filePath, contentDigest, reviewedAt })
      .onConflictDoUpdate({
        target: [reviewedFiles.reviewId, reviewedFiles.filePath],
        set: { contentDigest, reviewedAt }
      })
      .returning()
      .get()

    return toReviewedFile(row)
  }
}

export type ReviewedFilesService = typeof reviewedFilesService
