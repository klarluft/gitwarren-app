/**
 * The name this install answers to.
 *
 * A GitWarren install is about to stop being the only one in the world. Once a
 * GUI can talk to a daemon on another machine, three questions all need the
 * same answer: which host does this repository live on, which install does a
 * link point into, and which principal is "the local user" here. A UUID
 * generated once into the data directory is that answer.
 *
 * Deliberately a file rather than a row in SQLite, and deliberately free of any
 * `electron` import, for the same reason `paths.ts` is: the GUI, the MCP server
 * and - from M2 - the daemon are separate processes that must agree, and one of
 * them may need the id before, or without, opening the database.
 *
 * The id names the *install*, not the machine and not the person. Two copies of
 * GitWarren pointed at two data directories on one laptop are two instances,
 * which is what the rest of the system wants: a review lives in a database, and
 * the database is what the id is attached to.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { isInstanceId } from '../shared/instance-id.js'
import { ensureDataDirectory, getInstanceIdPath } from './paths.js'

/**
 * Cached for the life of the process. The file is written once and never
 * changes afterwards, so re-reading it per call would buy nothing at all.
 */
let cached: string | null = null

function readExisting(): string | null {
  try {
    const contents = readFileSync(getInstanceIdPath(), 'utf8').trim()
    // A value that is not shaped like a UUID came from something other than
    // this code, and there is nothing in it worth preserving.
    return isInstanceId(contents) ? contents : null
  } catch {
    return null
  }
}

/**
 * Create the file, or lose the race and read the winner's value.
 *
 * `wx` is the load-bearing part. First launch commonly starts the GUI and an
 * agent's MCP server within the same second, and a plain write would let both
 * of them mint an id and the second clobber the first - after the first had
 * already stamped it on a principal. An exclusive create makes exactly one of
 * them the author and sends the other back to read what was written.
 */
function readOrCreate(): string {
  const existing = readExisting()
  if (existing) return existing

  ensureDataDirectory()
  const minted = randomUUID()
  try {
    writeFileSync(getInstanceIdPath(), `${minted}\n`, { encoding: 'utf8', flag: 'wx' })
    return minted
  } catch {
    // Either someone else got there first, in which case their value is the
    // right one, or the file is unwritable. A second read tells them apart.
    const other = readExisting()
    if (other) return other
  }

  // The file exists and holds something this code did not write. There is no id
  // in it to preserve, so it is replaced - a plain write this time, since
  // `wx` is what just refused and no other process is racing for a name that
  // was never valid.
  try {
    writeFileSync(getInstanceIdPath(), `${minted}\n`, 'utf8')
    return minted
  } catch {
    // Nothing writable at all. Carry on with an id that lives only as long as
    // this process: an install that cannot write its own data directory has
    // larger problems, and refusing to start over a name would be the wrong
    // trade. Links minted now simply stop resolving when the process ends.
    console.error('[instance] could not persist the instance id; using a temporary one')
    return minted
  }
}

/** This install's id. Generated on first call, then stable forever. */
export function getInstanceId(): string {
  if (cached === null) cached = readOrCreate()
  return cached
}

/** Drops the cached value. For tests that switch data directories mid-run. */
export function resetInstanceIdCache(): void {
  cached = null
}
