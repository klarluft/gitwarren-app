/**
 * Where on disk the head branch is checked out.
 *
 * A reviewer usually arrives knowing the branch and wanting the directory: the
 * next thing they do after reading a review is go there - `cd` into it, hand it
 * to an agent, open it in an editor. With several linked worktrees of one
 * repository that directory is not guessable from the branch name, and the app
 * already knows it, because every comparison starts by asking
 * `git worktree list` where the head lives (see `core/git-compare.ts`).
 *
 * Two shapes for two places. The review header has room for the whole path,
 * shown with `FilePath` so the folder name - the part that tells two worktrees
 * of one repository apart - is the part that stands out. A row in the review
 * list does not, so it shows only the folder name and copies the full path.
 * Both copy the *full* path: a folder name on its own is not somewhere a shell
 * can go.
 *
 * Nothing is rendered when no worktree has the branch checked out; the tabs
 * already say so in `NoWorktreeNotice`, with the explanation that belongs to it.
 */
import { useRef } from 'react'
import { FolderGit2, FolderOpen } from 'lucide-react'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { useRevealPath } from '@/lib/reveal-path'
import { FilePath } from './file-path'
import { folderName } from './folder-name'
import type { GitWorktree } from '@shared/git'

/** Small enough to sit on a line of `text-xs` without making it taller. */
const INLINE_ICON_BUTTON = 'size-6 shrink-0 text-muted-foreground [&_svg]:size-3.5'

/** The full location, for the review header. */
export function WorktreeLocation({ worktree }: { worktree: GitWorktree }) {
  const pathRef = useRef<HTMLSpanElement>(null)

  return (
    // `items-start` so the icon and the label stay level with the first line
    // of a path long enough to wrap.
    <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
      <FolderGit2 className="mt-1 size-3.5 shrink-0" />
      <span className="mt-0.5 min-w-0">
        {/* Said in words because the two cases look identical otherwise, and
            they are not the same answer to "where do I go": the main checkout
            is the folder the repository is known by, a linked worktree is one
            of its siblings. */}
        <span className="mr-1.5">{worktree.isMain ? 'Main checkout' : 'Worktree'}</span>
        <span ref={pathRef}>
          <FilePath path={worktree.path} className="font-mono" />
        </span>
      </span>
      <PathActions path={worktree.path} source={pathRef} />
    </p>
  )
}

/**
 * Just the folder name, for a row in the review list.
 *
 * The full path is in the `title` because it is *not* on screen here - this is
 * the one place a tooltip on an identifier adds something rather than
 * repeating it.
 */
export function WorktreeFolder({ path }: { path: string }) {
  const nameRef = useRef<HTMLSpanElement>(null)

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <FolderGit2 className="size-3 shrink-0" />
      <span ref={nameRef} data-selectable className="min-w-0 break-words" title={path}>
        {folderName(path)}
      </span>
      <PathActions path={path} source={nameRef} />
    </span>
  )
}

/**
 * Copy, and show in the file manager where this machine can.
 *
 * Wrapped so a click here does not also open whatever row it sits in - the
 * review list's rows are links, and these buttons go somewhere else.
 */
function PathActions({
  path,
  source
}: {
  path: string
  source: React.RefObject<HTMLElement | null>
}) {
  // Null on a remote host this machine cannot name the path on; the button is
  // then absent rather than disabled, for the reason `useRevealPath` gives.
  // Copying is always offered: a path on another machine is still exactly what
  // goes after `ssh host cd`.
  const revealPath = useRevealPath(path)

  return (
    <span
      className="-my-1 inline-flex shrink-0 items-center"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      role="presentation"
    >
      <CopyButton
        label="Copy worktree path"
        text={path}
        source={source}
        className={INLINE_ICON_BUTTON}
      />
      {api.capabilities.revealPath && revealPath !== null && (
        <Tooltip label="Show in file manager">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Show worktree in file manager"
            className={INLINE_ICON_BUTTON}
            onClick={() => void api.system.revealPath(revealPath)}
          >
            <FolderOpen />
          </Button>
        </Tooltip>
      )}
    </span>
  )
}
