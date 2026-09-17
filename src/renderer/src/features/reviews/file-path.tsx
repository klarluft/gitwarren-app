/**
 * A repository path rendered so it can always be read in full.
 *
 * Truncation is the wrong answer for a path. The part that identifies a file
 * is its tail, an ellipsis eats exactly that, and a `title` tooltip only helps
 * someone who already suspects they are looking at the wrong file. So nothing
 * here clips: a path that does not fit wraps onto another line, which costs a
 * few pixels of header on the rare long path and never costs the reader the
 * name of the file they are reading.
 *
 * Two details make wrapped paths readable rather than merely complete:
 *  - Break opportunities are placed explicitly after each `/` with `<wbr>`.
 *    Browsers do not reliably offer one there, and without them a deep path
 *    either overflows or has to be broken with `break-all`, mid-word.
 *  - The directories are dimmed and the file name is not, so the eye lands on
 *    the name first even when the path in front of it is long.
 */
import { Fragment } from 'react'
import { HighlightedText } from '@/components/highlighted-text'
import { cn } from '@/lib/utils'

/** Split at the last separator: everything before it is where, after it is what. */
function splitPath(path: string): { directory: string; name: string } {
  const cut = path.lastIndexOf('/')
  if (cut === -1) return { directory: '', name: path }
  return { directory: path.slice(0, cut + 1), name: path.slice(cut + 1) }
}

/** The directory part, with a break opportunity after every separator. */
function Directory({ directory }: { directory: string }) {
  // `'src/lib/'.split('/')` ends in an empty segment; the slash of the segment
  // before it has already been printed, so that tail is dropped.
  const segments = directory.split('/').slice(0, -1)

  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={`${index}-${segment}`}>
          {segment}/<wbr />
        </Fragment>
      ))}
    </>
  )
}

export function FilePath({
  path,
  emphasizeName = true,
  className
}: {
  path: string
  /**
   * Whether the file name should stand out from its directories. Off where the
   * surrounding row is already one colour - a folder row in the file tree - and
   * a second emphasis would only add noise.
   */
  emphasizeName?: boolean
  className?: string
}) {
  const { directory, name } = splitPath(path)

  return (
    // `break-words` is the safety net under the explicit breaks: a single
    // segment longer than the column still wraps instead of overflowing.
    // Always selectable: several of these sit inside buttons, where the app's
    // stylesheet otherwise turns selection off, and a path you can read but not
    // copy is half a path.
    // No `title`: the text is all there, and a tooltip repeating it would only
    // shadow the more useful one on whatever row it sits in.
    <span data-selectable className={cn('break-words', className)}>
      {directory !== '' && (
        <span className={emphasizeName ? 'text-muted-foreground' : undefined}>
          <Directory directory={directory} />
        </span>
      )}
      <span className={emphasizeName ? 'font-medium text-foreground' : undefined}>{name}</span>
    </span>
  )
}

/**
 * A path in a *result* list: the name first, then where it lives.
 *
 * The same path as `FilePath`, read the other way round, and the difference is
 * what a filtered list is for. In a tree the directories are already on screen
 * as the rows above, so a row is a name and the eye walks down a column of
 * them. In a flat list of matches every row carries its whole path, and with
 * the path in file order the names - the only thing telling two results apart -
 * end up at four different columns down the list, behind the forty characters
 * of `src/renderer/src/features/` that every row shares. Deep files are the
 * ones this hurts most, which is exactly backwards: they are the ones a filter
 * is used to reach.
 *
 * So the name comes first, in the reader's colour, and its directory follows it
 * dimmed - the arrangement every editor's quick-open uses, for this reason.
 *
 * The matched characters are marked in both halves. `fuzzyMatch` numbers them
 * against the whole path, so they are split at the last separator here rather
 * than re-derived against the two pieces: matching a second time is how a
 * highlight comes to disagree with the ranking that put the row there.
 */
export function MatchedFilePath({
  path,
  indices,
  className
}: {
  path: string
  /** Indices into `path`, from `fuzzyMatch`. Empty renders it plain. */
  indices: readonly number[]
  className?: string
}) {
  const cut = path.lastIndexOf('/')
  const directory = cut === -1 ? '' : path.slice(0, cut)
  const name = path.slice(cut + 1)

  return (
    <span data-selectable className={cn('break-words', className)}>
      <span className="font-medium text-foreground">
        <HighlightedText
          text={name}
          indices={indices.filter((at) => at > cut).map((at) => at - cut - 1)}
        />
      </span>
      {directory !== '' && (
        // A space rather than a separator character: the colour change already
        // says where the name ends, and a dash or a bullet here would be one
        // more thing on a row that is mostly path.
        <span className="text-muted-foreground">
          {' '}
          <HighlightedText text={directory} indices={indices.filter((at) => at < cut)} />
        </span>
      )}
    </span>
  )
}
