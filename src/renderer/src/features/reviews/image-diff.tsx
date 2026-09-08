/**
 * The picture, instead of the words "binary file".
 *
 * A change to an image is two images, so this shows both ends of it side by
 * side - the version the branch started from and the version it has now -
 * labelled in the same red and green the line gutters use. A file that only
 * exists on one side gets one pane, because inventing an empty second one
 * would suggest the other version exists and is blank.
 *
 * The two sides are read independently: a rename means a different path on each
 * end, and one side failing (a blob that is gone, an image past the size
 * ceiling) should still leave the other on screen. Nothing is measured up
 * front - the browser decodes the image anyway, so the dimensions are taken
 * from the element once it has loaded rather than from a parser here.
 */
import { useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { fileSize } from '@/lib/format'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useReviewImage } from './use-reviews'
import type { DiffChanges, DiffFileSide, FileDiff } from '@shared/git'

/**
 * Which sides of the comparison hold an image, and under what path.
 *
 * Null means the file does not exist on that side at all. The base side of a
 * rename is the *old* path, which is the one detail a caller cannot guess from
 * `file.path` alone.
 */
export function imageSides(file: FileDiff): { base: string | null; head: string | null } {
  const gone = file.status === 'deleted'
  const fresh = file.status === 'added' || file.isUntracked
  return {
    base: fresh ? null : (file.oldPath ?? file.path),
    head: gone ? null : file.path
  }
}

/**
 * A transparent PNG should read as transparent rather than as white-on-white or
 * black-on-black, so it sits on the usual checkerboard. Drawn from the theme's
 * own muted colour, which keeps it quiet in both light and dark.
 */
const CHECKERBOARD = {
  backgroundImage:
    'repeating-conic-gradient(var(--muted) 0% 25%, var(--card) 0% 50%)',
  backgroundSize: '16px 16px'
}

const SIDE_LABELS: Record<DiffFileSide, string> = { base: 'Before', head: 'After' }

export function ImageDiff({
  file,
  reviewId,
  changes
}: {
  file: FileDiff
  reviewId: number
  changes: DiffChanges
}) {
  const sides = imageSides(file)
  const both = sides.base !== null && sides.head !== null

  return (
    <div
      className={cn(
        'grid gap-3 border-t border-border p-3',
        // One pane spans the width; two share it, and only once there is room
        // for both to stay legible - a narrow window stacks them instead.
        both && 'md:grid-cols-2'
      )}
    >
      {sides.base !== null && (
        <ImagePane
          reviewId={reviewId}
          path={sides.base}
          side="base"
          changes={changes}
          renamedFrom={both && sides.base !== sides.head ? sides.base : null}
        />
      )}
      {sides.head !== null && (
        <ImagePane
          reviewId={reviewId}
          path={sides.head}
          side="head"
          changes={changes}
          renamedFrom={null}
        />
      )}
    </div>
  )
}

function ImagePane({
  reviewId,
  path,
  side,
  changes,
  renamedFrom
}: {
  reviewId: number
  path: string
  side: DiffFileSide
  changes: DiffChanges
  /** Set on the base pane of a rename, where the old name is worth showing. */
  renamedFrom: string | null
}) {
  const { image, error, isLoading } = useReviewImage(reviewId, path, side, changes)
  /** Filled in by the browser once it has decoded the image. */
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)

  const problem = failed
    ? 'This image could not be displayed.'
    : (image?.error ?? (error === undefined ? null : errorMessage(error)))

  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <span className={side === 'base' ? 'text-destructive' : 'text-success'}>
          {SIDE_LABELS[side]}
        </span>
        {renamedFrom !== null && (
          <span className="min-w-0 truncate font-mono text-muted-foreground" title={renamedFrom}>
            {renamedFrom}
          </span>
        )}
        {size !== null && (
          <span className="font-mono text-muted-foreground tabular-nums">
            {size.width}×{size.height}
          </span>
        )}
        {image?.dataUrl && (
          <span className="font-mono text-muted-foreground tabular-nums">
            {fileSize(image.byteSize)}
          </span>
        )}
      </figcaption>

      {problem !== null ? (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-6 text-center text-xs text-muted-foreground">
          {problem}
        </p>
      ) : isLoading || !image?.dataUrl ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div
          className="flex items-center justify-center overflow-hidden rounded-md border border-border p-2"
          style={CHECKERBOARD}
        >
          <img
            src={image.dataUrl}
            alt={`${SIDE_LABELS[side]}: ${path}`}
            // Capped rather than free-scrolling: the point is to see what
            // changed at a glance, and a screenshot committed at retina size
            // would otherwise push the next file off the screen entirely.
            className="max-h-96 max-w-full object-contain"
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight
              })
            }
            onError={() => setFailed(true)}
          />
        </div>
      )}
    </figure>
  )
}
