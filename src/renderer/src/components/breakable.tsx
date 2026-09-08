/**
 * Text that wraps at its separators rather than mid-word.
 *
 * Browsers do not reliably offer a break opportunity after `/`, so a long
 * slash-separated string - a path, a branch name like
 * `feat/searchable-branch-picker-in-review-form` - either overflows its column
 * or has to be broken with `break-all`, which cuts through the middle of a
 * word and makes the result harder to read than the overflow was. An explicit
 * `<wbr>` after each separator gives the browser the break it would not find
 * on its own, so `break-words` can do the rest without ever splitting a
 * segment that would have fitted.
 *
 * See `features/reviews/file-path.tsx` for the same reasoning applied to a
 * path that also wants its directories dimmed; this is the plain-text half of
 * it, for the places that only need the wrapping.
 */
import { Fragment } from 'react'

/** Hyphens and dots already break naturally; only `/` needs the hint. */
export function Breakable({ text }: { text: string }) {
  if (!text.includes('/')) return <>{text}</>

  // `'a/b/'.split('/')` ends in an empty segment; the separator before it has
  // already been printed, so nothing is owed for that tail.
  const segments = text.split('/')

  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {segment}
          {index < segments.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </Fragment>
      ))}
    </>
  )
}
