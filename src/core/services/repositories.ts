/**
 * The repository service: the one implementation of every repository operation.
 *
 * Both surfaces call straight into this module - the IPC handlers in the main
 * process and the MCP tools in their own process - and neither adds validation
 * of its own. Every function re-parses its input with the shared zod schema
 * here rather than trusting the caller, so a bug in one surface cannot let a
 * bad write through that the other would have rejected. That is the whole
 * reason the module exists.
 */
import { asc, eq } from 'drizzle-orm'
import { getDatabase } from '../db/client.js'
import { repositories, type RepositoryRow } from '../db/schema.js'
import { defaultNameForPath, readGitState, resolveRepositoryRoot } from '../git.js'
import { readRepositoryRefs } from '../git-compare.js'
import { AppError } from '../../shared/errors.js'
import { parseWithSchema as parse } from '../../shared/validation.js'
import {
  addRepositoryInputSchema,
  getRepositoryInputSchema,
  removeRepositoryInputSchema,
  repositoryRefsInputSchema,
  updateRepositoryInputSchema,
  type Repository,
  type RepositoryWithGitState
} from '../../shared/schemas.js'
import type { RepositoryRefs } from '../../shared/git.js'

function toRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

async function withGitState(row: RepositoryRow): Promise<RepositoryWithGitState> {
  return { ...toRepository(row), git: await readGitState(row.path) }
}

function nowIso(): string {
  return new Date().toISOString()
}

function requireRow(id: number): RepositoryRow {
  const row = getDatabase().select().from(repositories).where(eq(repositories.id, id)).get()
  if (!row) throw new AppError('NOT_FOUND', `No repository with id ${id}.`)
  return row
}

/**
 * Turn SQLite's UNIQUE violation into the domain error. The service checks for
 * duplicates explicitly before writing; this is the backstop for the race where
 * the GUI and an agent add the same repository at the same moment.
 */
function asDuplicateError(error: unknown, path: string): AppError {
  const code = (error as { code?: string } | null)?.code
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return new AppError('DUPLICATE_REPOSITORY', `That repository is already tracked: ${path}`, {
      path: ['This repository is already in the list.']
    })
  }
  return AppError.from(error)
}

export const repositoriesService = {
  /** Every tracked repository, each with its git state read fresh. */
  async list(): Promise<RepositoryWithGitState[]> {
    const rows = getDatabase().select().from(repositories).orderBy(asc(repositories.name)).all()
    // Git calls are independent per row, so pay for the slowest one, not the sum.
    return Promise.all(rows.map(withGitState))
  },

  async get(input: unknown): Promise<RepositoryWithGitState> {
    const { id } = parse(getRepositoryInputSchema, input)
    return withGitState(requireRow(id))
  },

  /**
   * Branches, tags and worktrees, for the review endpoint pickers.
   *
   * Each local branch carries where it is checked out and whether that worktree
   * is dirty, so the user can see there is uncommitted work to review before
   * they even create the review.
   */
  async refs(input: unknown): Promise<RepositoryRefs> {
    const { id } = parse(repositoryRefsInputSchema, input)
    return readRepositoryRefs(requireRow(id).path)
  },

  /**
   * Add a repository. The given path may be any directory inside the working
   * tree; what gets stored is always the resolved repository root.
   */
  async add(input: unknown): Promise<Repository> {
    const { path, name } = parse(addRepositoryInputSchema, input)
    const root = await resolveRepositoryRoot(path)

    const existing = getDatabase().select().from(repositories).where(eq(repositories.path, root)).get()
    if (existing) {
      throw new AppError(
        'DUPLICATE_REPOSITORY',
        `That repository is already tracked as "${existing.name}".`,
        { path: [`Already tracked as "${existing.name}".`] }
      )
    }

    const timestamp = nowIso()
    try {
      const row = getDatabase()
        .insert(repositories)
        .values({
          path: root,
          name: name ?? defaultNameForPath(root),
          createdAt: timestamp,
          updatedAt: timestamp
        })
        .returning()
        .get()
      return toRepository(row)
    } catch (error) {
      throw asDuplicateError(error, root)
    }
  },

  /** Rename a repository and/or repoint it at a moved working copy. */
  async update(input: unknown): Promise<Repository> {
    const { id, name, path } = parse(updateRepositoryInputSchema, input)
    const current = requireRow(id)

    const changes: Partial<RepositoryRow> = { updatedAt: nowIso() }
    if (name !== undefined) changes.name = name

    if (path !== undefined) {
      // A new path goes through exactly the same validation as `add`.
      const root = await resolveRepositoryRoot(path)
      if (root !== current.path) {
        const clash = getDatabase().select().from(repositories).where(eq(repositories.path, root)).get()
        if (clash && clash.id !== id) {
          throw new AppError(
            'DUPLICATE_REPOSITORY',
            `Another entry ("${clash.name}") already points at that repository.`,
            { path: [`Already tracked as "${clash.name}".`] }
          )
        }
        changes.path = root
      }
    }

    try {
      const row = getDatabase()
        .update(repositories)
        .set(changes)
        .where(eq(repositories.id, id))
        .returning()
        .get()
      if (!row) throw new AppError('NOT_FOUND', `No repository with id ${id}.`)
      return toRepository(row)
    } catch (error) {
      throw asDuplicateError(error, changes.path ?? current.path)
    }
  },

  /**
   * Stop tracking a repository. Only the row is removed - GitWarren never
   * touches the working copy on disk.
   */
  // Every service method is async so callers get one uniform interface; whether
  // a given operation happens to touch the disk synchronously is an
  // implementation detail that should not leak into the signature.
  // eslint-disable-next-line @typescript-eslint/require-await
  async remove(input: unknown): Promise<{ id: number }> {
    const { id } = parse(removeRepositoryInputSchema, input)
    const row = getDatabase().delete(repositories).where(eq(repositories.id, id)).returning().get()
    if (!row) throw new AppError('NOT_FOUND', `No repository with id ${id}.`)
    return { id: row.id }
  }
}

export type RepositoriesService = typeof repositoriesService
