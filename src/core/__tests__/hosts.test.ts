/**
 * The host service: what a row means before and after a machine is met.
 *
 * Nothing here connects to anything. `hosts.probe` is the only function that
 * would, and it is exercised against a fake pool in `core/hosts/__tests__`;
 * what is left for this file is the part that lives in SQLite, which is where
 * the two duplicate rules and the identity write-back are.
 *
 * The interesting tests are the two about identity. A host added twice under
 * two different names is not something a form can detect - `pc-wsl` and
 * `xfor@100.78.0.23` are different strings and might well be different machines
 * - so the collision is only visible once the machine has said who it is, and
 * it has to be reported rather than quietly merged.
 *
 * These read synchronously because better-sqlite3 is synchronous and the
 * service stopped pretending otherwise; only `probe` waits for anything.
 */
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

import type { AppError as AppErrorInstance } from '../../shared/errors.js'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-hosts-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { hostsService } = await import('../services/hosts.js')
const { getDatabase, closeDatabase } = await import('../db/client.js')
const { hosts } = await import('../db/schema.js')
const { AppError } = await import('../../shared/errors.js')

beforeEach(() => {
  getDatabase().delete(hosts).run()
})

after(() => {
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
})

function expectError(run: () => unknown): AppErrorInstance {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof AppError)
    return error
  }
  throw new Error('Expected an AppError.')
}

test('a host is described before it is met', () => {
  const host = hostsService.add({ target: 'xfor@pc-wsl' })

  // Never connected, so nothing is claimed about which machine this is.
  assert.equal(host.instanceId, null)
  assert.equal(host.lastSeenAt, null)
  assert.equal(host.state.connected, false)
  assert.equal(host.kind, 'ssh')
})

test('the label defaults to the machine, not to the login', () => {
  // A list where every entry begins with the same username has stopped
  // distinguishing anything.
  assert.equal(hostsService.add({ target: 'xfor@pc-wsl' }).label, 'pc-wsl')
  assert.equal(hostsService.add({ target: 'vps.example.com' }).label, 'vps.example.com')
})

test('a name someone chose is kept', () => {
  assert.equal(hostsService.add({ target: 'xfor@pc-wsl', label: 'The PC' }).label, 'The PC')
})

test('a target that could be read as an option is refused', () => {
  // `ssh` would take this as a flag. It is spawned without a shell, so this is
  // belt and braces - but a carrier's safety should not rest on a spawn flag.
  const option = expectError(() => hostsService.add({ target: '-oProxyCommand=touch /tmp/x' }))
  assert.equal(option.code, 'INVALID_INPUT')

  const injected = expectError(() => hostsService.add({ target: 'host; rm -rf ~' }))
  assert.equal(injected.code, 'INVALID_INPUT')
  assert.ok(injected.fieldErrors?.target)
})

test('the same target twice is refused with something a form can show', () => {
  hostsService.add({ target: 'xfor@pc-wsl' })

  const error = expectError(() => hostsService.add({ target: 'xfor@pc-wsl' }))
  assert.equal(error.code, 'INVALID_INPUT')
  assert.deepEqual(error.fieldErrors?.target, ['This host is already in the list.'])
})

test('repointing a host at another machine forgets who it was', () => {
  const host = hostsService.add({ target: 'xfor@pc-wsl' })
  getDatabase()
    .update(hosts)
    .set({
      instanceId: '4e0b0adb-1085-43e4-92be-a9ca9bad985c',
      lastSeenAt: new Date().toISOString()
    })
    .run()

  const moved = hostsService.update({ id: host.id, target: 'xfor@other-box' })

  // The new address may be a different machine entirely, and keeping the old
  // identity would let a repository row follow an address instead of a machine.
  assert.equal(moved.instanceId, null)
  assert.equal(moved.lastSeenAt, null)
})

test('renaming a host keeps everything it had learned', () => {
  const host = hostsService.add({ target: 'xfor@pc-wsl' })
  const instanceId = '4e0b0adb-1085-43e4-92be-a9ca9bad985c'
  getDatabase().update(hosts).set({ instanceId }).run()

  const renamed = hostsService.update({ id: host.id, label: 'Work PC' })

  assert.equal(renamed.label, 'Work PC')
  assert.equal(renamed.instanceId, instanceId, 'a label is not an identity')
})

test('two names for one machine cannot both hold its identity', () => {
  // The database is the backstop, for the race the service check cannot cover.
  const instanceId = '4e0b0adb-1085-43e4-92be-a9ca9bad985c'
  const first = hostsService.add({ target: 'xfor@pc-wsl' })
  const second = hostsService.add({ target: 'xfor@100.78.0.23' })

  getDatabase().update(hosts).set({ instanceId }).where(eq(hosts.id, first.id)).run()

  assert.throws(() => {
    getDatabase().update(hosts).set({ instanceId }).where(eq(hosts.id, second.id)).run()
  }, /UNIQUE constraint failed: hosts.instance_id/)
})

test('but two hosts that have not been met are perfectly distinct', () => {
  // NULLs in a unique index are all different from one another, which is
  // exactly what is wanted here: "not met yet" is not an identity to collide.
  hostsService.add({ target: 'xfor@pc-wsl' })
  hostsService.add({ target: 'xfor@100.78.0.23' })

  const all = hostsService.list()
  assert.equal(all.length, 2)
  assert.ok(all.every((host) => host.instanceId === null))
})

test('removing a host that is not there says so', () => {
  assert.equal(expectError(() => hostsService.remove({ id: 999 })).code, 'NOT_FOUND')
})
