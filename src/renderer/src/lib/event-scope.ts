/**
 * Whether a cache key is one an event is news about.
 *
 * Three lines of string matching, in a file of their own, for the same reason
 * `lib/host-reachability.ts` has no React in it: this is the part worth
 * testing, and a test of it should be a node program. `lib/events.ts` - which
 * holds the table of which event names mean which key families - cannot be one,
 * because it reads `CACHE_PREFIXES` from `lib/api.ts` and that module throws at
 * import time without `window.gitwarren`, deliberately. So the rule moved out
 * and the table stayed.
 *
 * No imports at all, which is the property that makes that work.
 *
 * ## The scope is a suffix, and that is not an accident of spelling
 *
 * `scoped()` in `lib/api.ts` puts `@<instance>` on the *end* of every key that
 * names something a host owns, so that the family-wide `startsWith`
 * invalidation at the front still works. Asking from the other end gives
 * "everything about that machine", which is the question an event from a host
 * is asking - and the same trick `features/hosts/use-reconnect.ts` already uses
 * to bring a whole screen back when one read succeeds.
 *
 * Getting this wrong is invisible on screen. An event from `pc-wsl` that
 * matched this Mac's keys too would leave every screen correct and simply
 * re-read six machines' worth of SQLite every time an agent typed anything -
 * which is the kind of wrong a demo cannot show and this file exists to pin
 * down.
 */

/**
 * Does `key` belong to the install an event came from?
 *
 * `host` absent means the event is this install's own, and a key with no `@` in
 * it is this install's own - the same asymmetry every host-aware thing in this
 * app has, arriving from both ends at once.
 */
export function keyBelongsTo(key: string, host: string | undefined): boolean {
  return host === undefined ? !key.includes('@') : key.endsWith(`@${host}`)
}

/**
 * The whole decision: is this key in one of these families, on that machine?
 *
 * The host test comes first because it is the cheap one and it rejects most
 * keys on a screen that is looking at a different machine.
 */
export function eventClaimsKey(
  key: unknown,
  host: string | undefined,
  prefixes: readonly string[]
): boolean {
  return (
    typeof key === 'string' &&
    keyBelongsTo(key, host) &&
    prefixes.some((prefix) => key.startsWith(prefix))
  )
}
