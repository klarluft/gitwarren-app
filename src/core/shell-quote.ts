/**
 * Quoting a path for a file that a shell will run.
 *
 * Shared rather than private to one caller because there are now three
 * generated scripts on a machine that name absolute paths - the MCP launcher
 * the app writes, and the two launchers `gitwarren service install` writes -
 * and each is executed with the user's privileges every time an agent starts
 * or the machine boots. An app is not usually installed somewhere with a `$`
 * in its name, so this is ceremony almost always; the failure it prevents is
 * not the kind to leave to almost.
 *
 * No Electron here, and nothing but strings: the daemon needs it too.
 */

/** For inside a POSIX shell's double quotes. Returns the quotes as well. */
export function shellQuote(value: string): string {
  return `"${value.replace(/(["$`\\])/g, '\\$1')}"`
}

/**
 * For inside `cmd`'s double quotes.
 *
 * `cmd` has no escape character inside quotes - a backslash is a path
 * separator and nothing else - so the only thing to be done with an embedded
 * quote is refuse it. A Windows path cannot contain one anyway: the character
 * is illegal in a filename, which is what makes the refusal safe rather than a
 * gap.
 */
export function cmdQuote(value: string): string {
  if (value.includes('"')) throw new Error(`a Windows path cannot contain a quote: ${value}`)
  return `"${value}"`
}

/**
 * The inverse of `shellQuote`, for reading a generated launcher back.
 *
 * A launcher is written once and then read by three commands that have to know
 * what it points at: `gitwarren doctor`, which reports whether the target is
 * still there, and `update` and `uninstall`, which must not touch a launcher
 * belonging to some other GitWarren. Parsing the file we wrote is how that
 * question gets answered without a second file recording the answer - a sidecar
 * would be one more thing to go stale, and the launcher is the fact.
 *
 * Null rather than a throw for anything that is not a quoted string, because
 * every caller is asking about a file a human may have edited, and "I do not
 * recognise this" is an answer all of them handle.
 */
export function shellUnquote(value: string): string | null {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return null
  return value.slice(1, -1).replace(/\\(["$`\\])/g, '$1')
}

/** The inverse of `cmdQuote`. `cmd` has no escapes, so this is the quotes. */
export function cmdUnquote(value: string): string | null {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return null
  const inner = value.slice(1, -1)
  return inner.includes('"') ? null : inner
}
