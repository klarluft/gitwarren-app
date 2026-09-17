/**
 * Narrowing a list of paths by name - the filter box above both file lists.
 *
 * Shared by the browse tab's listing of the whole repository and the files tab's
 * list of what changed, because they are the same gesture: you know roughly
 * what the file is called and you want it in front of you without walking a
 * tree. That the two lists differ by three orders of magnitude does not change
 * the ranking; it only changes how much the ceiling matters.
 *
 * The result is deliberately a *flat, ranked* list rather than a pruned tree.
 * Once you are typing `revfiles` you are not navigating a hierarchy any more,
 * you are naming a file, and the directory rows in between are rows you have to
 * scroll past. Flat also keeps the keystroke cheap, because nothing is refolded
 * per key.
 *
 * DOM-free like `diff-search.ts`, and for the same reason: the ranking is the
 * part worth testing, and the tests here are node programs.
 */
// Relative rather than `@/lib/fuzzy`, which is the spelling everywhere else in
// the renderer. The tests are node programs compiled by `tsconfig.node.json`,
// which deliberately does not know the renderer's `@/` alias - the node side
// must not be able to import renderer code - so a module that wants a test
// reaches its neighbours by path. Same reason `diff-search.ts` imports nothing
// but types from outside its folder.
import { fuzzyMatch } from '../../lib/fuzzy'

export interface PathMatch {
  path: string
  /** Indices into `path` that the query hit, for the row to mark. */
  indices: number[]
}

export interface PathMatches {
  /** The best matches, at most `limit` of them. */
  shown: PathMatch[]
  /** How many matched in total, which may be more than were kept. */
  total: number
}

/**
 * How many matches a filter shows by default.
 *
 * Nobody scrolls to the hundredth-best fuzzy match; they type another letter.
 * The cap is what keeps a one-character query over a twenty-thousand-file
 * repository from rendering twenty thousand rows on the way to being narrowed.
 */
export const MAX_FILTER_MATCHES = 200

/**
 * Rank `paths` against `query`, best first.
 *
 * Ties break on the path itself rather than on the order the paths arrived, so
 * a list that is refreshed underneath a query does not quietly reshuffle rows
 * the reader was about to click.
 */
export function filterPaths(
  paths: readonly string[],
  query: string,
  limit: number = MAX_FILTER_MATCHES
): PathMatches {
  const needle = query.trim()
  if (needle === '') return { shown: [], total: 0 }

  const scored: { path: string; score: number; indices: number[] }[] = []
  for (const path of paths) {
    const hit = fuzzyMatch(needle, path)
    if (hit !== null) scored.push({ path, score: hit.score, indices: hit.indices })
  }
  scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))

  return {
    shown: scored.slice(0, limit).map(({ path, indices }) => ({ path, indices })),
    total: scored.length
  }
}
