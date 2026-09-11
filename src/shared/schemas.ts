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
import { ATTACHMENT_FILE_NAME } from './attachments.js'
import { DIGEST_MAX_LENGTH } from './diff-digest.js'
import type { DiffChanges, DiffLine } from './git.js'

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
  /**
   * The commit this history starts at, or null in a repository with no commits.
   *
   * The one field here that is not about *this* checkout. It is the same forty
   * characters in every clone of a project on every machine, which makes it the
   * only honest way to say "the thing on `pc-wsl` under `~/github.com` and the
   * thing on this Mac under `~/github.com` are the same repository". Neither
   * the path nor the name can say that: two clones are usually in different
   * places and are often called different things.
   *
   * Null is not a group. Two repositories with no commits yet are two empty
   * repositories, not one repository seen twice.
   */
  rootCommit: z.string().nullable(),
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
/* Hosts                                                                      */
/* -------------------------------------------------------------------------- */

export const MAX_TARGET_LENGTH = 255

export const hostIdSchema = z.number().int().positive()
export const hostKindSchema = z.enum(['ssh', 'wsl'])

/**
 * An SSH destination.
 *
 * Validated for shape rather than for reachability - whether a host answers is
 * something only a connection can say, and a form that tried to guess would
 * refuse perfectly good `~/.ssh/config` aliases it has no way to resolve.
 *
 * What is rejected is what would stop being a destination and start being an
 * argument: a leading `-` (which `ssh` would read as an option), and whitespace
 * or a shell metacharacter, neither of which can appear in a real target and
 * both of which are how a string in a form becomes a command on the local
 * machine. `ssh` is spawned without a shell, so this is belt-and-braces - but a
 * carrier's safety should not rest on a spawn flag somebody could change.
 */
export const sshTargetSchema = z
  .string()
  .trim()
  .min(1, 'Enter a host to connect to, like user@machine.')
  .max(MAX_TARGET_LENGTH)
  .refine((value) => !value.startsWith('-'), {
    message: 'A host cannot start with "-".'
  })
  .refine((value) => !/[\s;&|`$(){}<>'"\\]/.test(value), {
    message: 'A host can only contain a user name, an @ and a machine name.'
  })

/**
 * A WSL distribution name.
 *
 * The whole of a WSL host's target - there is no user half, and the schema note
 * on `hosts.target` says why. Shape only, like the ssh case above: which
 * distributions exist is something `wsl.exe -l -q` knows and a validator does
 * not, and the add form is a picker fed by exactly that, so a name reaching here
 * by hand is the unusual path rather than the normal one.
 *
 * What is rejected is what would stop being a name and start being an argument:
 * a leading `-`, and whitespace or a shell metacharacter. `wsl.exe` is spawned
 * without a shell and does read `-d --not-a-distro` as a name rather than a
 * flag, so this is belt-and-braces - but a carrier's safety should not rest on
 * a spawn flag somebody could change, and a slash is refused too because a
 * distribution name is never a path.
 */
export const wslDistroNameSchema = z
  .string()
  .trim()
  .min(1, 'Choose a WSL distribution.')
  .max(MAX_TARGET_LENGTH)
  .refine((value) => !value.startsWith('-'), {
    message: 'A distribution name cannot start with "-".'
  })
  .refine((value) => !/[\s;&|`$(){}<>'"\\/]/.test(value), {
    message: 'That is not a WSL distribution name.'
  })

/** Whichever of the two a host of this kind is addressed by. */
export function hostTargetSchemaFor(kind: 'ssh' | 'wsl'): z.ZodType<string> {
  return kind === 'wsl' ? wslDistroNameSchema : sshTargetSchema
}

/**
 * One WSL distribution, as this machine lists it.
 *
 * `name` is the whole of what identifies it, and is also what goes into
 * `hosts.target`. `isDefault` and `running` are there for the picker to draw
 * with, and neither is stored: which distribution is default can change while
 * the app is open, and whether one is running is exactly the kind of fact the
 * host row refuses to keep for the same reason it never stores reachability.
 *
 * `alreadyAdded` is the picker's own convenience - the answer to "why is this
 * one greyed out" - and is computed against the host list at the moment of
 * asking rather than being a property of the distribution.
 */
export const wslDistroSchema = z.object({
  name: z.string(),
  isDefault: z.boolean(),
  running: z.boolean(),
  alreadyAdded: z.boolean()
})

/** A row as stored, plus how it is doing right now. */
export const hostSchema = z.object({
  id: hostIdSchema,
  /** Null until the host has been reached once. See the schema note. */
  instanceId: z.string().nullable(),
  label: z.string(),
  kind: hostKindSchema,
  target: z.string(),
  editorTarget: z.string().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
  /** What GitWarren the host was running when it last said. Null until it has. */
  daemonVersion: z.string().nullable(),
  createdAt: z.iso.datetime()
})

/**
 * Reachability, which is never stored.
 *
 * Read from the connection pool at the moment of asking, for the same reason
 * git state is read live rather than cached: a host that was up ten minutes ago
 * is not a fact about now, and a screen showing one as though it were is the
 * bug this whole milestone has to avoid.
 */
export const hostStateSchema = z.object({
  connected: z.boolean(),
  failures: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  retryAfter: z.number().optional()
})

export const hostWithStateSchema = hostSchema.extend({ state: hostStateSchema })

/**
 * Adding a host, where what counts as a valid target depends on the carrier.
 *
 * A `superRefine` rather than a discriminated union, because `kind` is optional
 * - every host added before M5 was an `ssh` one and says so by saying nothing -
 * and a union cannot discriminate on a key that may be absent. The alternative
 * was one permissive target rule for both, which would have cost the two error
 * messages that are the only reason a person knows which field they got wrong:
 * "Enter a host to connect to, like user@machine" and "Choose a WSL
 * distribution" are not interchangeable advice.
 */
export const addHostInputSchema = z
  .object({
    target: z.string().trim().min(1).max(MAX_TARGET_LENGTH),
    /** Defaults to the target with any `user@` removed. */
    label: z.string().trim().min(1, 'Name cannot be empty.').max(MAX_NAME_LENGTH).optional(),
    kind: hostKindSchema.optional(),
    editorTarget: z.string().trim().max(MAX_TARGET_LENGTH).optional()
  })
  .superRefine((value, ctx) => {
    const parsed = hostTargetSchemaFor(value.kind ?? 'ssh').safeParse(value.target)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      // Re-pathed onto `target`, so the message lands under the input the
      // person typed into rather than in the dialog's general slot - which is
      // the thing M4.3 found broken across the preload and M4.4 fixed.
      ctx.addIssue({ code: 'custom', message: issue.message, path: ['target'] })
    }
  })

export const updateHostInputSchema = z
  .object({
    id: hostIdSchema,
    label: z.string().trim().min(1, 'Name cannot be empty.').max(MAX_NAME_LENGTH).optional(),
    target: sshTargetSchema.optional(),
    editorTarget: z.string().trim().max(MAX_TARGET_LENGTH).nullable().optional()
  })
  .refine(
    (value) =>
      value.label !== undefined || value.target !== undefined || value.editorTarget !== undefined,
    { message: 'Provide something to change.', path: ['label'] }
  )

export const getHostInputSchema = z.object({ id: hostIdSchema })
export const removeHostInputSchema = z.object({ id: hostIdSchema })

/**
 * `force` is the difference between "make sure GitWarren is on that machine"
 * and "put it there again".
 *
 * Without it an install of a version that is already there is a no-op with a
 * sentence, which is what the button does by default - pressing it twice should
 * not move 45 MB. With it, it reinstalls: the case that needs this is a daemon
 * directory that is present, reports the right version and is somehow broken,
 * and a person who has decided that is what happened is right more often than
 * a version string is.
 */
export const installOnHostInputSchema = z.object({
  id: hostIdSchema,
  force: z.boolean().optional()
})

/** What the install did. See `core/hosts/install.ts` for why each is separate. */
export const installActionSchema = z.enum(['installed', 'upgraded', 'already-current'])

export const installReportSchema = z.object({
  action: installActionSchema,
  version: z.string(),
  previousVersion: z.string().nullable(),
  target: z.string(),
  bytes: z.number().int().nonnegative(),
  /** The host row afterwards, so a screen does not have to re-read it. */
  host: hostWithStateSchema
})

export type WslDistro = z.infer<typeof wslDistroSchema>
export type Host = z.infer<typeof hostSchema>
export type HostWithState = z.infer<typeof hostWithStateSchema>
export type HostConnectionState = z.infer<typeof hostStateSchema>
export type AddHostInput = z.input<typeof addHostInputSchema>
export type UpdateHostInput = z.input<typeof updateHostInputSchema>
export type GetHostInput = z.input<typeof getHostInputSchema>
export type RemoveHostInput = z.input<typeof removeHostInputSchema>
export type InstallOnHostInput = z.input<typeof installOnHostInputSchema>
export type InstallAction = z.infer<typeof installActionSchema>
export type InstallReport = z.infer<typeof installReportSchema>

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

/**
 * The two endpoints may be the *same* ref. That review is not empty: it holds
 * whatever is uncommitted in the worktree that has the ref checked out, which
 * is the state a reviewer most often wants a second pair of eyes on before it
 * becomes a commit. See `isSelfReview`.
 */
export const createReviewInputSchema = z.object({
  repositoryId: repositoryIdSchema,
  /** Defaults to "<head> into <base>", or "Uncommitted work on <ref>" when the
   *  two endpoints are the same ref. */
  title: z.string().trim().min(1, 'Title cannot be empty.').max(MAX_TITLE_LENGTH).optional(),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  /** What the changes are measured against - usually the trunk. */
  baseRef: refSchema,
  /** The branch under review. */
  headRef: refSchema
})

/**
 * Is this review a ref compared against itself?
 *
 * Shared rather than inlined because the answer changes copy in four places -
 * the review header, the list row, both tabs' empty states - and they should
 * never disagree about what the user is looking at.
 */
export function isSelfReview(refs: { baseRef: string; headRef: string }): boolean {
  return refs.baseRef === refs.headRef
}

/** The title a review gets when the user did not write one. */
export function defaultReviewTitle(baseRef: string, headRef: string): string {
  return isSelfReview({ baseRef, headRef })
    ? `Uncommitted work on ${headRef}`
    : `${headRef} into ${baseRef}`
}

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

/**
 * Which changes to read - see `DiffChanges`. `all` by default: reviewing work
 * before it is committed is the reason this app exists.
 *
 * Listed as a constant rather than inline so the enum and the type it mirrors
 * are checked against each other at compile time.
 */
const DIFF_CHANGES = ['committed', 'all', 'uncommitted'] as const satisfies readonly DiffChanges[]

export const diffChangesSchema = z.enum(DIFF_CHANGES).optional().default('all')

export const reviewDiffInputSchema = z.object({
  id: reviewIdSchema,
  changes: diffChangesSchema
})

/**
 * One file of a review, read whole so the diff can be expanded past its hunks.
 * `changes` has to match the diff on screen, or the expanded context would come
 * from a different version of the file than the hunks around it.
 */
export const reviewFileInputSchema = z.object({
  id: reviewIdSchema,
  path: z.string().min(1).max(4096),
  changes: diffChangesSchema
})

/**
 * One side's bytes of an image in a review. `side` is explicit because a
 * preview shows both ends of the change at once, and `path` goes with it - a
 * renamed file has a different name on each side.
 */
export const reviewImageInputSchema = reviewFileInputSchema.extend({
  // Spelled out rather than reusing `diffSideSchema`, which is declared further
  // down with the comment schemas and would not exist yet at this point.
  side: z.enum(['base', 'head'])
})

/**
 * The same file, on its way to the user's editor. `editorId` comes from
 * `system.editors()`; an unknown one falls back to the first editor found
 * rather than failing, because the alternative is a dead button.
 */
export const openReviewFileInputSchema = reviewFileInputSchema.extend({
  line: z.number().int().min(1).optional().default(1),
  editorId: z.string().max(64).optional(),
  /**
   * Which machine the review - and therefore the file - is on. Absent means
   * this one.
   *
   * The one place in this file a host appears in params rather than on the
   * envelope, and it is not an exception to `RpcRequest.host` but a consequence
   * of it: this input never goes on a wire. It is a shell channel, answered by
   * the main process of the machine with the screen on it, which has to do two
   * different things with the host - ask *that* machine for the path, and then
   * tell a local editor that the path is over there. `ssh-remote+<target>` is
   * part of the URL it opens, so the host is part of what is being opened.
   */
  host: z.string().max(200).optional()
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
export type ReviewImageInput = z.input<typeof reviewImageInputSchema>
export type OpenReviewFileInput = z.input<typeof openReviewFileInputSchema>
export type RepositoryRefsInput = z.input<typeof repositoryRefsInputSchema>

/* -------------------------------------------------------------------------- */
/* Reviewed files                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A file the reviewer has ticked off, and the fingerprint of what they read.
 *
 * The digest is handed back to the UI rather than compared in the service on
 * purpose. Only the renderer knows which diff is actually on screen - the
 * "include uncommitted" switch changes it - and a mark checked against any
 * other version of the file would be answering a question nobody asked.
 */
export const reviewedFileSchema = z.object({
  reviewId: reviewIdSchema,
  filePath: z.string(),
  contentDigest: z.string(),
  reviewedAt: z.string()
})

export const listReviewedFilesInputSchema = z.object({ reviewId: reviewIdSchema })

/**
 * Tick a file off, or take the tick back.
 *
 * One nullable field rather than a `reviewed` boolean beside an optional
 * digest, because those two can contradict each other and this cannot: a
 * digest is a mark on that exact diff, and null is no mark at all.
 */
export const setFileReviewedInputSchema = z.object({
  reviewId: reviewIdSchema,
  filePath: z.string().min(1).max(4096),
  contentDigest: z.string().min(1).max(DIGEST_MAX_LENGTH).nullable()
})

export type ReviewedFile = z.infer<typeof reviewedFileSchema>
export type ListReviewedFilesInput = z.input<typeof listReviewedFilesInputSchema>
export type SetFileReviewedInput = z.input<typeof setFileReviewedInputSchema>

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
    startLine: z.number().int().positive().optional(),
    /**
     * Which diff the line numbers were read off - see `DiffChanges`. The base
     * side of a `uncommitted` diff numbers the head commit, not the merge base,
     * so the anchor has to be captured from the same diff the commenter was
     * looking at or it would be taken from a different line entirely.
     */
    changes: diffChangesSchema
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

/**
 * Which image to read out of the store, by the name a body already names it by.
 *
 * A name rather than a sha and an extension, because that is what the callers
 * have: both shells are serving a URL whose last segment is `<sha>.<ext>`, and
 * splitting it only to join it again is where a dot goes missing. The pattern
 * is the security boundary and is checked here as well as by whoever is doing
 * the serving - see `ATTACHMENT_FILE_NAME`, and note that this is a method a
 * comment body written by an agent can reach through a rendered image.
 */
export const readAttachmentInputSchema = z.object({
  name: z.string().regex(ATTACHMENT_FILE_NAME, 'That is not an attachment name.')
})

/**
 * An image, small enough to have crossed a wire.
 *
 * base64 rather than bytes, because this answer is `JSON.stringify`d onto an
 * ndjson frame by whoever serves it - the same encoding `attachments.ingest`
 * takes on the way in, going the other way. It is a third larger than the file,
 * and that is the price of the store being on a different computer: the ingest
 * limit is what bounds it, and the browser cache is what stops it being paid
 * twice, since the name is the hash of the bytes and can therefore be cached
 * for ever.
 *
 * `mimeType` is the store's own conclusion from sniffing the bytes at ingest,
 * never a claim made by a filename - see `core/services/attachments.ts`.
 */
export const attachmentBytesSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int(),
  /** The file itself, base64-encoded. */
  base64: z.string()
})

export type AnchorSnapshot = z.infer<typeof anchorSnapshotSchema>
export type Attachment = z.infer<typeof attachmentSchema>
/**
 * Which machine a picked image is being attached to. Absent means this one.
 *
 * A shell channel rather than a method, for the same reason the picker itself
 * is: it opens a window. What crosses the wire afterwards is `attachments.ingest`
 * with bytes on it, because a path picked here is a name only this machine
 * knows - see the note on `pickAttachment` in `shared/api.ts`.
 */
export const pickAttachmentInputSchema = z.object({
  host: z.string().max(200).optional()
})

export type ReadAttachmentInput = z.input<typeof readAttachmentInputSchema>
export type AttachmentBytes = z.infer<typeof attachmentBytesSchema>
export type PickAttachmentInput = z.input<typeof pickAttachmentInputSchema>
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

/* -------------------------------------------------------------------------- */
/* Browsing a filesystem                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which folder to look inside. Absent means "wherever a person starts", which
 * is the answering machine's home directory.
 *
 * A leading `~` is expanded by whoever answers, because that is the only
 * machine that knows what it stands for - see `core/services/fs.ts`.
 */
export const listDirectoryInputSchema = z.object({
  path: z.string().max(4096).optional()
})

/** One subdirectory of the folder being listed. */
export const directoryEntrySchema = z.object({
  name: z.string(),
  /** Absolute, on the answering machine. What goes into the path field. */
  path: z.string(),
  /** It holds a `.git`, so it can be added without going any deeper. */
  isRepository: z.boolean(),
  /** Whether the screen should keep it behind the "show hidden" switch. */
  isHidden: z.boolean()
})

/**
 * One folder, as seen from a machine that cannot look at it itself.
 *
 * More than a list of names, because the asking side has to draw a picker for a
 * filesystem it has never seen: `parent` is the way up (null at the root, which
 * is how the screen knows to stop offering it), `home` is where the "Home"
 * button goes, and `separator` is the difference between a Mac driving a Linux
 * host and a Windows one.
 */
export const directoryListingSchema = z.object({
  /** The folder actually listed, resolved - `~` expanded, `..` collapsed. */
  path: z.string(),
  parent: z.string().nullable(),
  home: z.string(),
  separator: z.string(),
  entries: z.array(directoryEntrySchema),
  /** True when there were more subdirectories than one listing may carry. */
  truncated: z.boolean()
})

export type ListDirectoryInput = z.input<typeof listDirectoryInputSchema>
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>
export type DirectoryListing = z.infer<typeof directoryListingSchema>

/**
 * Whether this machine is reachable on its tailnet, and where.
 *
 * In `shared/` rather than beside the implementation in `core/web/exposure.ts`
 * because the renderer draws the switch and the renderer may not import
 * `core/`. It is the same split `HostWithState` has: the shape is everyone's,
 * and the machinery for producing it is one side's.
 *
 * A schema and not just a type, even though nothing validates an *outgoing*
 * one, so that a screen on the other end of a carrier has the same guarantee
 * about this answer as it has about every other.
 */
export const tailnetExposureSchema = z.object({
  /**
   * Whether this machine has a working Tailscale at all: installed, logged in,
   * daemon running. False covers all three failures because no screen can act
   * on the difference - the switch is not offered, and rule 3 says Tailscale is
   * never a dependency.
   */
  available: z.boolean(),
  /** This machine's MagicDNS name, or null. */
  dnsName: z.string().nullable(),
  /** The owner's Tailscale login, so a person can see whose tailnet this is. */
  login: z.string().nullable(),
  /** Whether the loopback port is being served on the tailnet right now. */
  exposed: z.boolean(),
  /**
   * Where the web view is for a phone, mount included:
   * `http://pc-wsl.tail688c0c.ts.net:41427/app/`. Null when not exposed.
   *
   * The mount is part of it because the two shells serve the app at different
   * paths - a URL naming only the origin would land a phone on the Electron
   * link page rather than in the app. The scheme is whatever `tailscale serve`
   * actually managed, never assumed: see `core/tailnet.ts`.
   */
  webRoot: z.string().nullable()
})

export type TailnetExposure = z.infer<typeof tailnetExposureSchema>

/**
 * Turning "Reachable on your tailnet" on or off.
 *
 * One boolean, and it is a schema rather than a bare argument for the reason
 * every other input here is: whoever answers re-parses what it was sent, and a
 * method whose params were a naked value would be the one place that rule did
 * not hold.
 */
export const setTailnetExposureInputSchema = z.object({
  exposed: z.boolean()
})

export type SetTailnetExposureInput = z.infer<typeof setTailnetExposureInputSchema>
