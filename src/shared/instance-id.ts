/**
 * What an instance id looks like, on its own.
 *
 * Split from `core/instance.ts`, which mints and stores one, because two places
 * that cannot import it need to recognise one: the route grammar in
 * `shared/routes.ts`, which is compiled for the renderer, and anything else
 * validating a host segment that arrived from outside.
 *
 * Nothing here touches a global or a node module, for the same reason
 * `routes.ts` does not.
 */

/**
 * A lowercase hex UUID, which is what `core/instance.ts` writes.
 *
 * Kept narrow on purpose. A host segment in a link is a string someone else
 * chose - an agent's comment body, a URL in a chat window - and the parser that
 * reads it should accept the one shape this app produces rather than any
 * plausible-looking identifier.
 */
export const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isInstanceId(value: string): boolean {
  return INSTANCE_ID_PATTERN.test(value)
}
