/**
 * Checking that a ref is a ref before handing it to git.
 *
 * ## What this is for, and what it is not
 *
 * Every caller of this app is its owner, so this is not a security boundary and
 * pretending otherwise would be dishonest. It is hygiene, and the thing it
 * closes is argument confusion rather than injection: `execFile` is used
 * everywhere and there is no shell, but git commands take revisions, options
 * and pathspecs in the same argv, and a value that is none of the three can
 * still make a command mean something its caller did not intend.
 *
 * The reason it lands now rather than later is that the refs stop being local
 * in M4. A ref stored on this machine is one the user picked from their own
 * branches; a ref that arrives over a carrier from another host has been
 * through a network and a second install first. The rule is much easier to put
 * in while every caller is still trustworthy than afterwards.
 *
 * ## Why not simply put `--` in front of it
 *
 * Because for the commands that take a revision, `--` does not mean "stop
 * reading options". It means "everything after this is a *path*", which for
 * `git rev-parse -- main` turns the ref into a filename and quietly produces
 * the wrong answer instead of an error. `--` belongs before pathspecs, and
 * `git-compare.ts` puts it there. Refs get this instead.
 *
 * ## Why `git check-ref-format`
 *
 * The rules for a valid ref name are long, exception-ridden and versioned with
 * git (no `..`, no ASCII control characters, no `~^:?*[`, no component starting
 * with a dot or ending in `.lock`, no trailing slash, and more). Reimplementing
 * them here would mean maintaining a second, slightly wrong copy forever. git
 * ships the check as a command precisely so that programs do not have to.
 */
import { runGit } from './git-exec.js'

/**
 * How long a ref may be. Matches the schema's ceiling; the point is only to
 * keep something absurd out of an argv, not to enforce a git rule.
 */
const MAX_REF_LENGTH = 512

/**
 * The suffixes that turn a ref name into a revision.
 *
 * `HEAD~3`, `main^2`, `v1.0^{commit}`, `main@{yesterday}` are all things a user
 * may legitimately have typed into a review, and none of them is a ref *name* -
 * `check-ref-format` rejects every one. So the suffixes are peeled off and the
 * name underneath is what gets checked. Order matters: the brace forms have to
 * be tried before the bare `^` that starts them.
 */
const REVISION_SUFFIXES = [/\^\{[^{}]*\}$/, /@\{[^{}]*\}$/, /\^\d*$/, /~\d*$/]

/**
 * Answers cached for the life of the process.
 *
 * The check is pure syntax and does not depend on the repository, so one cache
 * serves all of them. It exists because `resolveCompare` runs on every read of
 * every review - opening one screen would otherwise pay for two extra `git`
 * processes it does not need.
 */
const answers = new Map<string, boolean>()

/** Bounded so a pathological caller cannot turn the cache into a leak. */
const MAX_CACHED_ANSWERS = 1_000

function stripRevisionSuffixes(ref: string): string {
  let name = ref
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of REVISION_SUFFIXES) {
      const stripped = name.replace(suffix, '')
      if (stripped !== name) {
        name = stripped
        changed = true
      }
    }
  }
  return name
}

/**
 * The cheap rejections, made without spawning anything.
 *
 * A leading `-` is the one that matters: it is the only value in this file that
 * could be read as an option by a command that has already been given its
 * arguments. The rest are things `check-ref-format` would reject anyway, caught
 * here because a control character has no business reaching an argv at all.
 */
function isObviouslyNotARef(ref: string): boolean {
  if (ref.length === 0 || ref.length > MAX_REF_LENGTH) return true
  if (ref.startsWith('-')) return true
  // C0 controls, space and DEL. A NUL in particular would truncate the argument
  // rather than be refused by whatever reads it.
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0020\u007f]/.test(ref)
}

/**
 * Whether git would accept this as a way of naming a commit.
 *
 * Deliberately permissive about *revisions* and strict about *names*: the
 * question being asked is "could a user plausibly have meant this", not "does
 * it exist". Existence is asked separately, on every read, because branches get
 * deleted while a review is open.
 */
export async function isValidRef(ref: string, cwd: string): Promise<boolean> {
  const cached = answers.get(ref)
  if (cached !== undefined) return cached

  const answer = await computeIsValidRef(ref, cwd)

  // Nothing clever about the eviction: the cache is a saved process spawn, and
  // a rare miss after a flush costs one of them back.
  if (answers.size >= MAX_CACHED_ANSWERS) answers.clear()
  answers.set(ref, answer)
  return answer
}

async function computeIsValidRef(ref: string, cwd: string): Promise<boolean> {
  if (isObviouslyNotARef(ref)) return false

  const name = stripRevisionSuffixes(ref)
  // Everything peeled away: `^`, `~3` and friends name a commit relative to
  // something, and there is nothing here for them to be relative to.
  if (name.length === 0) return false
  if (isObviouslyNotARef(name)) return false

  // `--allow-onelevel` is what permits `main`, `HEAD` and a raw sha, none of
  // which have a slash in them. Without it only `refs/heads/main` would pass.
  const result = await runGit(['check-ref-format', '--allow-onelevel', name], cwd)
  return result.code === 0
}

/** Drops the cache. For tests; nothing in the app needs to call it. */
export function resetRefValidationCache(): void {
  answers.clear()
}
