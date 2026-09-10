/**
 * The per-launch token that stands between a loopback port and everything on
 * this machine that can reach it.
 *
 * Jupyter's arrangement, for Jupyter's reason. A port on 127.0.0.1 is not a
 * private thing: every process the user runs can connect to it, and so can any
 * web page the user happens to have open, since a browser will cheerfully issue
 * requests to loopback from a page served by anyone at all. The link server
 * could ignore that by being inert - it answers one static page and holds no
 * capability worth stealing. A server that reads repositories and writes
 * comments cannot, so it needs to know that whoever is asking was told the
 * secret.
 *
 * Three properties, and each one is doing work:
 *
 *  - **Per launch, never persisted across one.** The token is minted in memory
 *    at startup. Nothing has to expire it, revoking it is `quit`, and a token
 *    left in a shell history is worthless by the next boot.
 *  - **Written to a file only the user can read.** `gitwarren open` in M3.3 has
 *    to find it without the user copying anything, and 0600 in the data
 *    directory is how. It is deliberately not put in `daemon-runtime.json`,
 *    which is a published fact about the machine written with ordinary
 *    permissions; a secret does not belong in a file whose whole purpose is to
 *    be read by other processes.
 *  - **Compared in constant time.** The comparison is against a value an
 *    attacker supplies and can retry, which is the exact shape a timing oracle
 *    needs. `timingSafeEqual` costs nothing here and removes the question.
 *
 * What it is *not* is authentication of a person. Rule 5 says identity is a
 * principal, and the principal on loopback is "whoever is at this machine".
 * This gate answers a narrower question - was this request made by something
 * the user pointed at GitWarren, or by a page that merely knows the port.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDataDirectory, getDataDirectory } from '../paths.js'

/**
 * 32 bytes. Long past any brute force over a socket, short enough that the URL
 * it goes into is still one line in a terminal.
 */
const TOKEN_BYTES = 32

const TOKEN_FILE_NAME = 'web-token'

export function getWebTokenPath(): string {
  return join(getDataDirectory(), TOKEN_FILE_NAME)
}

/** A fresh token. base64url so it survives a query string untouched. */
export function mintWebToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Publish the token for `gitwarren open` to find.
 *
 * `writeFileSync` with `mode` only applies the mode when it *creates* the file,
 * so an existing file left by an earlier launch would keep whatever permissions
 * it had. Removing it first is what makes the 0600 unconditional, and the
 * explicit `chmodSync` covers the platforms where the umask still had its say.
 * Windows ignores both, which is expected: there the file inherits the user
 * profile's ACL, and that is the same protection by a different mechanism.
 *
 * Logged rather than thrown, like `writeDaemonRuntime`: a machine that cannot
 * write this file has lost `gitwarren open`, not the server, and the URL is on
 * stderr either way.
 */
export function publishWebToken(token: string): void {
  try {
    ensureDataDirectory()
    const path = getWebTokenPath()
    rmSync(path, { force: true })
    writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  } catch (error) {
    console.error('[web] could not publish the session token', error)
  }
}

/** Remove it on the way out. Missing is the same as gone. */
export function clearWebToken(): void {
  try {
    rmSync(getWebTokenPath(), { force: true })
  } catch (error) {
    console.error('[web] could not remove the session token', error)
  }
}

/**
 * Whether a presented value is the token.
 *
 * The length check before `timingSafeEqual` is required rather than an
 * optimisation - it throws on buffers of different lengths - and it leaks only
 * the length of a value the caller already knows the length of.
 */
export function isWebToken(token: string, presented: string | undefined): boolean {
  if (presented === undefined) return false
  const expected = Buffer.from(token, 'utf8')
  const actual = Buffer.from(presented, 'utf8')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}
