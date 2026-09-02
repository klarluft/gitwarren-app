/**
 * Fuzzy subsequence matching, for the command palette.
 *
 * A palette lives or dies by whether "rfl" finds "review-files-tab" and whether
 * the thing you meant is at the top. Both come down to scoring, so this does a
 * little more than the usual `indexOf` chain: characters must appear in order,
 * but where they appear decides the score - the start of a word beats the
 * middle of one, and a run of adjacent characters beats the same letters spread
 * across the string. That is what makes "gwa" rank `gitwarren-app` above
 * `growing-away`, which a plain subsequence test cannot do.
 *
 * The matched positions come back with the score so the palette can underline
 * exactly what the query hit. Without that, a fuzzy result looks like a guess.
 */

/** Path and identifier punctuation: the character after one starts a word. */
const SEPARATORS = new Set(['/', '\\', '-', '_', ' ', '.', ':', '@', '#'])

const START_OF_STRING = 14
const START_OF_WORD = 10
const CAMEL_HUMP = 8
/** Paid per character that continues an unbroken run, so runs beat scatter. */
const ADJACENT = 12
/** Charged per skipped character, so a compact match beats a scattered one. */
const GAP_STEP = 1
/** Cap on the same charge for a *leading* skip, so a hit deep in a long path
 *  is still reachable - "index" must find `src/features/reviews/index.ts`. */
const MAX_LEAD_PENALTY = 12
const SAME_CASE = 1

export interface FuzzyMatch {
  score: number
  /** Indices into the searched text, ascending. Highlight these. */
  indices: number[]
}

function isUpper(character: string): boolean {
  return character !== character.toLowerCase() && character === character.toUpperCase()
}

/** How much it is worth to match at this position, ignoring what came before. */
function positionBonus(text: string, index: number): number {
  if (index === 0) return START_OF_STRING
  const previous = text[index - 1] as string
  if (SEPARATORS.has(previous)) return START_OF_WORD
  if (!isUpper(previous) && isUpper(text[index] as string)) return CAMEL_HUMP
  return 0
}

/**
 * Score `query` against `text`, or null if the characters are not all there.
 *
 * The search is a small dynamic program: `best[j]` is the score of the best
 * match for the query so far that ends with the current query character placed
 * at `text[j]`. Sweeping the text once per query character keeps it linear in
 * their product, which matters because this runs over every command and every
 * repository, review and changed file on each keystroke.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = query.trim()
  if (needle.length === 0) return { score: 0, indices: [] }
  if (needle.length > text.length) return null

  const lowerQuery = needle.toLowerCase()
  const lowerText = text.toLowerCase()

  const width = text.length
  // Scores for the previous query character, and where each came from, so the
  // winning path can be walked back into a list of highlight positions.
  let previousRow = new Float64Array(width).fill(-Infinity)
  const parents: Int32Array[] = []

  for (let i = 0; i < lowerQuery.length; i += 1) {
    const row = new Float64Array(width).fill(-Infinity)
    const parent = new Int32Array(width).fill(-1)

    // The best score reachable from any earlier position of the previous query
    // character, decayed as it travels right. Carrying it forward this way
    // charges for the gap without re-scanning the row for every position.
    let carried = -Infinity
    let carriedFrom = -1

    for (let j = 0; j < width; j += 1) {
      if (j > 0) {
        // Decay first: whatever was already carried has now skipped one more
        // character than it had. Then the position just passed joins the race
        // with no gap of its own yet. Together these keep `carried` equal to
        // the best previous-row score minus the distance travelled from it.
        if (carried > -Infinity) carried -= GAP_STEP
        const candidate = previousRow[j - 1] as number
        if (candidate > carried) {
          carried = candidate
          carriedFrom = j - 1
        }
      }

      if (lowerText[j] !== lowerQuery[i]) continue

      const bonus =
        positionBonus(text, j) + (text[j] === needle[i] && isUpper(text[j] as string) ? SAME_CASE : 0)

      if (i === 0) {
        // A first character is free to land anywhere, but landing late in a
        // long string is weaker evidence than landing at its start.
        row[j] = bonus - Math.min(j * GAP_STEP, MAX_LEAD_PENALTY)
        parent[j] = -1
        continue
      }

      const adjacent = j > 0 ? (previousRow[j - 1] as number) : -Infinity
      const runScore = adjacent > -Infinity ? adjacent + ADJACENT : -Infinity

      if (runScore >= carried && runScore > -Infinity) {
        row[j] = runScore + bonus
        parent[j] = j - 1
      } else if (carried > -Infinity) {
        row[j] = carried + bonus
        parent[j] = carriedFrom
      }
    }

    parents.push(parent)
    previousRow = row
  }

  let end = -1
  let score = -Infinity
  for (let j = 0; j < width; j += 1) {
    if ((previousRow[j] as number) > score) {
      score = previousRow[j] as number
      end = j
    }
  }
  if (end === -1 || score === -Infinity) return null

  const indices: number[] = []
  for (let i = parents.length - 1; i >= 0 && end !== -1; i -= 1) {
    indices.push(end)
    end = (parents[i] as Int32Array)[end] as number
  }
  indices.reverse()

  return { score, indices }
}

/**
 * Match against a label and, failing that, against hidden keywords.
 *
 * Keyword hits score lower than label hits by a flat margin, so a command whose
 * *name* contains the query always outranks one that merely lists it as an
 * alias - "files" should reach "Files changed" before "Refresh (reloads files)".
 */
const KEYWORD_HANDICAP = 30

export function scoreCandidate(
  query: string,
  label: string,
  keywords?: string
): FuzzyMatch | null {
  const direct = fuzzyMatch(query, label)
  if (direct) return direct
  if (keywords === undefined) return null

  const indirect = fuzzyMatch(query, keywords)
  // Indices point into the keywords, which are never rendered, so drop them.
  return indirect ? { score: indirect.score - KEYWORD_HANDICAP, indices: [] } : null
}
