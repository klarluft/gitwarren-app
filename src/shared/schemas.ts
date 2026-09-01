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
