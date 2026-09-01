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
import type { DiffLine } from './git.js'

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

/**
 * One file of a review, read whole so the diff can be expanded past its hunks.
 * `includeUncommitted` has to match the diff on screen, or the expanded context
 * would come from a different version of the file than the hunks around it.
 */
export const reviewFileInputSchema = z.object({
  id: reviewIdSchema,
  path: z.string().min(1).max(4096),
  includeUncommitted: z.boolean().optional().default(true)
})

/**
 * The same file, on its way to the user's editor. `editorId` comes from
 * `system.editors()`; an unknown one falls back to the first editor found
 * rather than failing, because the alternative is a dead button.
 */
export const openReviewFileInputSchema = reviewFileInputSchema.extend({
  line: z.number().int().min(1).optional().default(1),
  editorId: z.string().max(64).optional()
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
export type ReviewFileInput = z.input<typeof reviewFileInputSchema>
export type OpenReviewFileInput = z.input<typeof openReviewFileInputSchema>
export type RepositoryRefsInput = z.input<typeof repositoryRefsInputSchema>

/* -------------------------------------------------------------------------- */
/* Comments                                                                   */
/* -------------------------------------------------------------------------- */

export const MAX_COMMENT_LENGTH = 20_000
export const MAX_AGENT_LABEL_LENGTH = 60

export const commentIdSchema = z.number().int().positive()
export const threadIdSchema = z.number().int().positive()
export const diffSideSchema = z.enum(['base', 'head'])

/**
 * Note what is *not* here: no author fields on any input schema.
 *
 * Authorship is a property of the transport, not of the payload. A comment that
 * came in over IPC is a human because typing it into the app is the only way to
 * send it, and one that came in over MCP is an agent for the same reason. Every
 * service call takes its actor as a second argument, supplied by the surface,
 * so no caller can claim to be someone else by putting it in the body - which
 * would be the one way this app could start lying about which review feedback
 * was written by a machine.
 */
export const commentAuthorSchema = z.object({
  kind: z.enum(['human', 'agent']),
  name: z.string(),
  label: z.string().nullable(),
  session: z.string().nullable()
})

/**
 * An image referenced by a comment body, resolved.
 *
 * The body itself holds only an opaque `gitwarren://attachment/<sha>.<ext>`
 * token; this is that token looked up. Two consumers need different things from
 * it and both are served here rather than by two shapes: the renderer fetches
 * `url` through the custom protocol, and an agent reads `path`, which is a real
 * file on disk.
 *
 * `path` is what makes attachments work for agents at all, and it is why there
 * is no `get_attachment` tool. Returning an MCP `ImageContent` block would put
 * the delivery of the image at the mercy of each client's handling of it, which
 * varies; handing over an absolute path uses the image-reading path every
 * coding agent already has.
 */
export const commentAttachmentSchema = z.object({
  /** The token as it appears in the body. */
  url: z.string(),
  /** Absolute path to the file. Agents read this directly. */
  path: z.string(),
  /** Alt text as written in the markdown - what a non-vision agent "sees". */
  alt: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int(),
  /** Null when the header could not be read; both are for layout and for
   *  telling an agent what it is about to open. */
  width: z.number().int().nullable(),
  height: z.number().int().nullable()
})

/**
 * A file just copied into the store, before anything refers to it.
 *
 * Deliberately not the same shape as `commentAttachment`: there is no `alt`
 * yet, because alt text is a property of the reference in a body rather than of
 * the file, and the caller is the thing that decides it. `originalName` is here
 * and not there for the mirror-image reason - it is only useful at the moment
 * of attaching, as a default description to offer.
 */
export const attachmentSchema = z.object({
  sha: z.string(),
  url: z.string(),
  path: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  originalName: z.string().nullable()
})

export const commentSchema = z.object({
  id: commentIdSchema,
  threadId: threadIdSchema,
  author: commentAuthorSchema,
  body: z.string(),
  /**
   * Every image the body refers to, resolved. Empty for the great majority of
   * comments. Carried on the comment rather than fetched separately so that an
   * agent listing a review's discussion has the file paths in the same response
   * as the text that talks about them.
   */
  attachments: z.array(commentAttachmentSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
})

/**
 * The code a line comment was written against, frozen at the moment it was
 * written.
 *
 * This is GitHub's `diff_hunk` under a different name, and it is here for
 * GitHub's reason. A review in GitWarren follows two ref *names*, so the code
 * under a comment keeps changing; `anchorText` is enough to *detect* that the
 * line has been rewritten, but not enough to show a reader what the comment was
 * ever about. Once the line is gone, this snapshot is the only remaining record
 * of it - so an outdated comment can still be read, rather than sitting alone
 * next to nothing.
 *
 * It is a snapshot and is never rewritten. A thread with a live anchor is drawn
 * against the current diff instead; this is what is left when that fails.
 */
export const diffLineSchema = z.object({
  type: z.enum(['context', 'insert', 'delete']),
  content: z.string(),
  oldNumber: z.number().int().nullable(),
  newNumber: z.number().int().nullable()
}) satisfies z.ZodType<DiffLine>

export const anchorSnapshotSchema = z.object({
  /** The commented line last, with the lines that led up to it before it. */
  lines: z.array(diffLineSchema),
  /** True when the hunk started further up than the snapshot reaches. */
  clipped: z.boolean()
})

/**
 * A thread and every message in it.
 *
 * `filePath`/`side`/`line` are null together for a review-level thread - the
 * conversation tab - and set together for one anchored to a line of the diff.
 */
export const commentThreadSchema = z.object({
  id: threadIdSchema,
  reviewId: reviewIdSchema,
  filePath: z.string().nullable(),
  side: diffSideSchema.nullable(),
  /** Last line of the comment's range - a single-line comment is a range of one. */
  line: z.number().int().positive().nullable(),
  /** First line of the range. Null when the comment is about one line. */
  startLine: z.number().int().positive().nullable(),
  /** The line's text when the thread was opened; see `shared/comment-anchors.ts`. */
  anchorText: z.string().nullable(),
  /** Head sha at that moment, so the UI can say what was being looked at. */
  anchorSha: z.string().nullable(),
  /** The code as it looked when the comment was written; see above. */
  anchorSnapshot: anchorSnapshotSchema.nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  comments: z.array(commentSchema)
})

const commentBodySchema = z
  .string()
  .trim()
  .min(1, 'Write something first.')
  .max(MAX_COMMENT_LENGTH, 'That comment is too long.')

export const listCommentsInputSchema = z.object({ reviewId: reviewIdSchema })

/**
 * Open a thread. Omit the anchor for a review-level comment; give `filePath`
 * and `line` together to attach it to a line of the diff.
 */
export const createThreadInputSchema = z
  .object({
    reviewId: reviewIdSchema,
    body: commentBodySchema,
    /** Path as it appears in the diff. Omit for a review-level comment. */
    filePath: z.string().trim().min(1).optional(),
    /**
     * Which side `line` numbers. Head is the default because commenting on
     * code as it will exist is the overwhelmingly common case; base is for
     * remarking on a line the change deleted.
     */
    side: diffSideSchema.optional().default('head'),
    /**
     * The line the comment is about; the *last* line of the range when it is
     * about several. The anchor text is taken from this one, so it is the line
     * the comment follows if the code moves.
     */
    line: z.number().int().positive().optional(),
    /**
     * First line of the range, for a comment about a block of code rather than
     * a single line. Omit for one line. Must be on the same side and no later
     * than `line`.
     */
    startLine: z.number().int().positive().optional()
  })
  .refine((value) => (value.filePath === undefined) === (value.line === undefined), {
    message: 'A line comment needs both a file and a line number.',
    path: ['line']
  })
  .refine((value) => value.startLine === undefined || value.line !== undefined, {
    message: 'A range needs a line to end at.',
    path: ['startLine']
  })
  .refine((value) => value.startLine === undefined || value.startLine <= (value.line ?? 0), {
    message: 'The range has to start at or before the line it ends on.',
    path: ['startLine']
  })

export const replyToThreadInputSchema = z.object({
  threadId: threadIdSchema,
  body: commentBodySchema
})

export const updateCommentInputSchema = z.object({
  id: commentIdSchema,
  body: commentBodySchema
})

export const removeCommentInputSchema = z.object({ id: commentIdSchema })

export const setThreadResolvedInputSchema = z.object({
  threadId: threadIdSchema,
  resolved: z.boolean()
})

/**
 * A handle an agent picks for its own session, so two concurrent sessions of
 * the same tool are told apart in the thread. Optional everywhere: an agent
 * that never sets one is still identified by its tool name and session id.
 */
export const agentLabelSchema = z
  .string()
  .trim()
  .min(1, 'A label cannot be empty.')
  .max(MAX_AGENT_LABEL_LENGTH, 'That label is too long.')

export type AnchorSnapshot = z.infer<typeof anchorSnapshotSchema>
export type Attachment = z.infer<typeof attachmentSchema>
export type CommentAttachment = z.infer<typeof commentAttachmentSchema>
export type CommentAuthorData = z.infer<typeof commentAuthorSchema>
export type Comment = z.infer<typeof commentSchema>
export type CommentThread = z.infer<typeof commentThreadSchema>
export type ListCommentsInput = z.input<typeof listCommentsInputSchema>
export type CreateThreadInput = z.input<typeof createThreadInputSchema>
export type ReplyToThreadInput = z.input<typeof replyToThreadInputSchema>
export type UpdateCommentInput = z.input<typeof updateCommentInputSchema>
export type RemoveCommentInput = z.input<typeof removeCommentInputSchema>
export type SetThreadResolvedInput = z.input<typeof setThreadResolvedInputSchema>
