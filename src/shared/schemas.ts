/**
 * The single source of truth for repository validation.
 *
 * These schemas are consumed by:
 *   - the core service layer (which parses every input itself, so no caller can
 *     skip validation),
 *   - the React forms in the renderer,
 *   - the MCP tool definitions (`.shape` becomes the tool input schema).
 *
 * Adding a rule here applies it to all three at once, which is what keeps the
 * UI and the agent surface from drifting apart.
 */
import { z } from 'zod'

export const MAX_NAME_LENGTH = 120

export const repositoryIdSchema = z.number().int().positive()

/** A row as stored. Note there is deliberately no git state in here. */
export const repositorySchema = z.object({
  id: repositoryIdSchema,
  /** Absolute, canonical path to the repository root. Unique. */
  path: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
})

/**
 * Live git facts, read on demand and never persisted. Every field is nullable
 * because the directory may have been moved or deleted since it was added.
 */
export const repositoryGitStateSchema = z.object({
  /** Does the recorded path still exist on disk? */
  exists: z.boolean(),
  /** Is it still a git repository? */
  isGitRepository: z.boolean(),
  /** Current branch, or null when detached / unreadable. */
  branch: z.string().nullable(),
  /** Short commit sha when HEAD is detached. */
  detachedAt: z.string().nullable(),
  /** True for a freshly `git init`-ed repo with no commits yet. */
  isEmpty: z.boolean(),
  /** Human-readable reason the state could not be read, if any. */
  error: z.string().nullable()
})

export const repositoryWithGitStateSchema = repositorySchema.extend({
  git: repositoryGitStateSchema
})

export const addRepositoryInputSchema = z.object({
  /**
   * Any path inside the repository. It is resolved to the repository root
   * before storing, so adding `/repo/src/foo` and `/repo` are the same thing.
   */
  path: z.string().trim().min(1, 'Choose a folder inside a git repository.'),
  /** Defaults to the folder name of the resolved repository root. */
  name: z.string().trim().min(1, 'Name cannot be empty.').max(MAX_NAME_LENGTH).optional()
})

export const updateRepositoryInputSchema = z
  .object({
    id: repositoryIdSchema,
    name: z.string().trim().min(1, 'Name cannot be empty.').max(MAX_NAME_LENGTH).optional(),
    /** Repointing at a moved repository. Re-validated and re-resolved like add. */
    path: z.string().trim().min(1, 'Path cannot be empty.').optional()
  })
  .refine((value) => value.name !== undefined || value.path !== undefined, {
    message: 'Provide a new name or a new path.',
    path: ['name']
  })

export const getRepositoryInputSchema = z.object({ id: repositoryIdSchema })
export const removeRepositoryInputSchema = z.object({ id: repositoryIdSchema })

export type Repository = z.infer<typeof repositorySchema>
export type RepositoryGitState = z.infer<typeof repositoryGitStateSchema>
export type RepositoryWithGitState = z.infer<typeof repositoryWithGitStateSchema>
export type AddRepositoryInput = z.input<typeof addRepositoryInputSchema>
export type UpdateRepositoryInput = z.input<typeof updateRepositoryInputSchema>
export type GetRepositoryInput = z.input<typeof getRepositoryInputSchema>
export type RemoveRepositoryInput = z.input<typeof removeRepositoryInputSchema>

/* -------------------------------------------------------------------------- */
/* Reviews                                                                    */
/* -------------------------------------------------------------------------- */

export const MAX_TITLE_LENGTH = 200
export const MAX_DESCRIPTION_LENGTH = 20_000
export const MAX_REF_LENGTH = 255

export const reviewIdSchema = z.number().int().positive()
export const reviewStatusSchema = z.enum(['open', 'closed'])

/**
 * A ref as the user picked it - a branch name, a tag, a sha.
 *
 * Refs are passed to `git` as arguments, so a value starting with `-` would be
 * read as an option rather than a ref. `execFile` is used everywhere (no shell),
 * which rules out injection; this rule closes the remaining argument-confusion
 * gap. Whether the ref actually exists is git's question, not zod's, and it is
 * asked again on every read because branches get deleted.
 */
const refSchema = z
  .string()
  .trim()
  .min(1, 'Choose a branch.')
  .max(MAX_REF_LENGTH, 'That ref name is too long.')
  .refine((ref) => !ref.startsWith('-'), { message: 'A ref cannot start with "-".' })

/** A stored review. As with repositories, no live git state is in here. */
export const reviewSchema = z.object({
  id: reviewIdSchema,
  repositoryId: repositoryIdSchema,
  title: z.string(),
  description: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  status: reviewStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable()
})

/** A review together with the repository it belongs to, for the detail screen. */
export const reviewWithRepositorySchema = reviewSchema.extend({
  repository: repositorySchema
})

export const listReviewsInputSchema = z.object({
  /** Omit to list reviews across every tracked repository. */
  repositoryId: repositoryIdSchema.optional(),
  status: reviewStatusSchema.optional()
})

export const createReviewInputSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    /** Defaults to "<head> into <base>", the way a repository name defaults to
     *  its folder name. */
    title: z.string().trim().min(1, 'Title cannot be empty.').max(MAX_TITLE_LENGTH).optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    /** What the changes are measured against - usually the trunk. */
    baseRef: refSchema,
    /** The branch under review. */
    headRef: refSchema
  })
  .refine((value) => value.baseRef !== value.headRef, {
    message: 'Pick two different refs - a ref compared against itself is empty.',
    path: ['headRef']
  })

export const updateReviewInputSchema = z
  .object({
    id: reviewIdSchema,
    title: z.string().trim().min(1, 'Title cannot be empty.').max(MAX_TITLE_LENGTH).optional(),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    baseRef: refSchema.optional(),
    headRef: refSchema.optional(),
    status: reviewStatusSchema.optional()
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.baseRef !== undefined ||
      value.headRef !== undefined ||
      value.status !== undefined,
    { message: 'Provide at least one field to change.', path: ['title'] }
  )

export const getReviewInputSchema = z.object({ id: reviewIdSchema })
export const removeReviewInputSchema = z.object({ id: reviewIdSchema })
export const reviewCommitsInputSchema = z.object({ id: reviewIdSchema })

export const reviewDiffInputSchema = z.object({
  id: reviewIdSchema,
  /**
   * Fold the head worktree's uncommitted work into the diff. On by default:
   * reviewing work before it is committed is the reason this app exists. Has no
   * effect when no worktree has the head branch checked out.
   */
  includeUncommitted: z.boolean().optional().default(true)
})

export const repositoryRefsInputSchema = z.object({ id: repositoryIdSchema })

export type Review = z.infer<typeof reviewSchema>
export type ReviewWithRepository = z.infer<typeof reviewWithRepositorySchema>
export type ReviewStatus = z.infer<typeof reviewStatusSchema>
export type ListReviewsInput = z.input<typeof listReviewsInputSchema>
export type CreateReviewInput = z.input<typeof createReviewInputSchema>
export type UpdateReviewInput = z.input<typeof updateReviewInputSchema>
export type GetReviewInput = z.input<typeof getReviewInputSchema>
export type RemoveReviewInput = z.input<typeof removeReviewInputSchema>
export type ReviewCommitsInput = z.input<typeof reviewCommitsInputSchema>
export type ReviewDiffInput = z.input<typeof reviewDiffInputSchema>
export type RepositoryRefsInput = z.input<typeof repositoryRefsInputSchema>
