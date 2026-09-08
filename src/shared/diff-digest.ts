/**
 * A short fingerprint of one file's diff, used to expire a "Reviewed" mark.
 *
 * Marking a file reviewed is a statement about a particular piece of code -
 * "I have read this" - and it has to stop being true the moment that code
 * changes. Storing a flag alone could not express that: the next commit would
 * leave a tick next to work nobody has looked at, which is worse than no tick
 * at all. So what gets stored is this digest of what the reviewer actually saw,
 * and the mark counts only while the file still hashes to the same value.
 *
 * Not a cryptographic hash, deliberately. The comparison happens in the
 * renderer, against the diff already on screen, so it has to be synchronous -
 * and `crypto.subtle` is async-only. Nothing here defends against an adversary;
 * the job is to notice that a file changed, and 106 bits of cyrb53 does that
 * with collisions far rarer than the git operations around it failing.
 *
 * The digest covers everything the card renders: the path, how the file
 * changed, and every line of every hunk including the `@@` headers. Anything
 * that alters the diff therefore clears the mark - including flipping "include
 * uncommitted", which genuinely does show different code and so should not
 * inherit a tick earned against the committed version.
 */
import type { FileDiff } from './git.js'

/**
 * cyrb53, a well-known non-cryptographic string hash. Two multiply-xor lanes
 * mixed at the end; returns 53 bits, the most a JS number carries exactly.
 */
function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * Everything about the file the reviewer could have read, as one string.
 *
 * Line numbers ride along inside the hunk headers rather than being written
 * per row: a change above shifts the header, which is exactly when the file
 * below it deserves a second look anyway.
 */
function canonical(file: FileDiff): string {
  const parts: string[] = [
    file.path,
    file.oldPath ?? '',
    file.status,
    file.isBinary ? 'binary' : 'text',
    file.isUntracked ? 'untracked' : 'tracked',
    file.truncated ? 'clipped' : 'whole',
    // A binary file has no hunks to hash, so its byte counts are the only
    // evidence it changed at all.
    `${file.additions},${file.deletions}`
  ]

  for (const hunk of file.hunks) {
    parts.push(hunk.header)
    for (const line of hunk.lines) parts.push(`${line.type[0]}${line.content}`)
  }

  // NUL as the separator: it cannot occur in a path or in a line of a text
  // diff, so no two different files can canonicalise to the same string by
  // having their fields run together.
  return parts.join('\u0000')
}

/** Length of what `fileDiffDigest` returns, at most. Sizes the stored column. */
export const DIGEST_MAX_LENGTH = 32

/**
 * The fingerprint of a file's diff: two independently seeded passes, hex, so a
 * collision needs both lanes to agree.
 */
export function fileDiffDigest(file: FileDiff): string {
  const text = canonical(file)
  return `${cyrb53(text, 0).toString(16)}-${cyrb53(text, 0x9e3779b9).toString(16)}`
}
