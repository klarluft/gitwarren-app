/**
 * Coverage for the store behind the "Reviewed" tick.
 *
 * The service itself is small, so what is worth testing is the part that is
 * easy to get wrong and impossible to notice: a tick has to be one row per
 * file, replaced in place when the file is read again. A second row for the
 * same path would leave two answers to "has this been read", and whichever one
 * the list happened to return first would win.
 *
 * The digest comparison deliberately lives in the renderer, not here - see
 * `shared/diff-digest.ts` - so these tests are about storage, not staleness.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

import type { AppError as AppErrorInstance } from '../../shared/errors.js'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-reviewed-data-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { reviewedFilesService } = await import('../services/reviewed-files.js')
const { getDatabase, closeDatabase } = await import('../db/client.js')
const { repositories, reviews, reviewedFiles } = await import('../db/schema.js')
const { AppError } = await import('../../shared/errors.js')
const { eq } = await import('drizzle-orm')

/** A review row and nothing else: this service never looks at git. */
function makeReview(headRef = 'feature'): number {
  const database = getDatabase()
  const repository = database
    .insert(repositories)
    .values({ path: join(dataDir, `repo-${headRef}-${Math.random()}`), name: 'repo' })
    .returning()
    .get()

  return database
    .insert(reviews)
    .values({ repositoryId: repository.id, title: 'A review', baseRef: 'main', headRef })
    .returning()
    .get().id
}

beforeEach(() => {
  const database = getDatabase()
  database.delete(reviewedFiles).run()
  database.delete(reviews).run()
  database.delete(repositories).run()
})

after(() => {
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
})

test('a file starts unmarked', async () => {
  const reviewId = makeReview()
  assert.deepEqual(await reviewedFilesService.list({ reviewId }), [])
})

test('marking a file records the digest it was marked against', async () => {
  const reviewId = makeReview()
  const mark = await reviewedFilesService.setReviewed({
    reviewId,
    filePath: 'src/app.ts',
    contentDigest: 'abc123'
  })

  assert.equal(mark?.filePath, 'src/app.ts')
  assert.equal(mark?.contentDigest, 'abc123')
  assert.ok(mark && Date.parse(mark.reviewedAt) > 0)

  assert.deepEqual(await reviewedFilesService.list({ reviewId }), [mark])
})

test('reading a changed file again replaces the mark rather than adding one', async () => {
  const reviewId = makeReview()
  await reviewedFilesService.setReviewed({
    reviewId,
    filePath: 'src/app.ts',
    contentDigest: 'before'
  })
  await reviewedFilesService.setReviewed({
    reviewId,
    filePath: 'src/app.ts',
    contentDigest: 'after'
  })

  const marks = await reviewedFilesService.list({ reviewId })
  assert.equal(marks.length, 1)
  assert.equal(marks[0]?.contentDigest, 'after')
})

test('a null digest takes the mark off', async () => {
  const reviewId = makeReview()
  await reviewedFilesService.setReviewed({
    reviewId,
    filePath: 'src/app.ts',
    contentDigest: 'abc123'
  })

  const cleared = await reviewedFilesService.setReviewed({
    reviewId,
    filePath: 'src/app.ts',
    contentDigest: null
  })

  assert.equal(cleared, null)
  assert.deepEqual(await reviewedFilesService.list({ reviewId }), [])
})

test('clearing a file that was never marked is not an error', async () => {
  const reviewId = makeReview()
  assert.equal(
    await reviewedFilesService.setReviewed({
      reviewId,
      filePath: 'src/never-read.ts',
      contentDigest: null
    }),
    null
  )
})

test('two reviews of the same file keep their own marks', async () => {
  const first = makeReview('feature-a')
  const second = makeReview('feature-b')

  await reviewedFilesService.setReviewed({
    reviewId: first,
    filePath: 'src/app.ts',
    contentDigest: 'abc123'
  })

  assert.equal((await reviewedFilesService.list({ reviewId: first })).length, 1)
  assert.deepEqual(await reviewedFilesService.list({ reviewId: second }), [])
})

test('marks go when the review does', async () => {
  const reviewId = makeReview()
  await reviewedFilesService.setReviewed({
    reviewId,
    filePath: 'src/app.ts',
    contentDigest: 'abc123'
  })

  getDatabase().delete(reviews).where(eq(reviews.id, reviewId)).run()

  const left = getDatabase()
    .select()
    .from(reviewedFiles)
    .where(eq(reviewedFiles.reviewId, reviewId))
    .all()
  assert.deepEqual(left, [])
})

test('a review that does not exist is rejected rather than silently stored', async () => {
  const missing = 987654

  for (const call of [
    () => reviewedFilesService.list({ reviewId: missing }),
    () =>
      reviewedFilesService.setReviewed({
        reviewId: missing,
        filePath: 'src/app.ts',
        contentDigest: 'abc123'
      })
  ]) {
    let caught: AppErrorInstance | null = null
    try {
      await call()
    } catch (error) {
      assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`)
      caught = error
    }
    assert.equal(caught?.code, 'NOT_FOUND')
  }
})

test('a digest longer than the column allows is rejected', async () => {
  const reviewId = makeReview()
  await assert.rejects(
    () =>
      reviewedFilesService.setReviewed({
        reviewId,
        filePath: 'src/app.ts',
        contentDigest: 'x'.repeat(1000)
      }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT'
  )
})
