/**
 * Whether a request stays here.
 *
 * The router is the one place that decides, and getting it wrong is quiet in
 * both directions: a request that should have been forwarded is answered with
 * *this* machine's data under another machine's heading, and one that should
 * have stayed here goes out over a wire it had no business being on. Neither
 * looks like a failure from the screen.
 *
 * So what is pinned here is the decision, not the delivery. Actually reaching a
 * host is `ssh.ts`, `stdio-client.ts` and the pool, each covered where it
 * lives, and the whole of it verified end to end against the real `pc-wsl` node
 * - which is where M4.1, M4.2 and M4.3 each found the bug the tests could not
 * have. What a test *can* hold still is the three ways a request is answered
 * locally and the one way it is not.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-router-'))
process.env.GITWARREN_DATA_DIR = dataDir

const { isAnsweredLocally, route, handleRoutedRequest } = await import('../router.js')
const { getInstanceId } = await import('../../instance.js')
const { getDatabase, closeDatabase } = await import('../../db/client.js')
const { hosts } = await import('../../db/schema.js')
const { AppError } = await import('../../../shared/errors.js')

/** A host this install has met but which is not this install. */
const OTHER = 'c0ffee00-0000-4000-8000-000000000001'
/** A host nobody has ever heard of - what a stale link carries. */
const STRANGER = 'c0ffee00-0000-4000-8000-0000000000ff'

before(() => {
  getDatabase()
    .insert(hosts)
    .values({ label: 'pc-wsl', kind: 'ssh', target: 'xfor@pc-wsl', instanceId: OTHER })
    .run()
})

after(() => {
  closeDatabase()
  rmSync(dataDir, { recursive: true, force: true })
})

test('no host on the envelope is this machine, as it always was', () => {
  assert.equal(isAnsweredLocally(undefined, 'repositories.list'), true)
})

test('our own instance id is this machine', () => {
  // Not a curiosity: it is what another GitWarren writes when it links *to*
  // this one, and rule 4 says a link resolves where it is clicked. Answering it
  // here rather than looking for a `hosts` row pointing at ourselves is that
  // rule in one comparison.
  assert.equal(isAnsweredLocally(getInstanceId(), 'reviews.open'), true)
})

test('a host list is answered by whoever is asked, even when a host is named', () => {
  // The mesh rule. Forwarding `hosts.*` would make host A's list readable - and
  // removable - from host B. The carrier refuses to send them as a backstop;
  // this is the layer that means the carrier never sees one.
  assert.equal(isAnsweredLocally(OTHER, 'hosts.list'), true)
  assert.equal(isAnsweredLocally(OTHER, 'hosts.remove'), true)
  assert.equal(isAnsweredLocally(OTHER, 'hosts.install'), true)
})

test('a repository on a host this install knows is not answered here', () => {
  assert.equal(isAnsweredLocally(OTHER, 'repositories.list'), false)
})

test('a host id nobody knows is NOT_FOUND, and the message names it', async () => {
  // What a link to a machine that has since been forgotten produces. Naming the
  // id is the whole of the message's value: it is the only thing the reader can
  // compare against their Hosts screen.
  try {
    await route(STRANGER, 'repositories.list')
    throw new Error('expected the route to reject')
  } catch (error) {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, 'NOT_FOUND')
    assert.ok(error.message.includes(STRANGER), `message should name the host: ${error.message}`)
  }
})

test('an unknown host is refused before anything is sent', async () => {
  // A `hosts` row is what turns an id into a way of connecting, so an id with
  // no row cannot produce a connection attempt at all - there is nothing to
  // connect to. The assertion is that it fails as a lookup rather than as a
  // timeout.
  const started = Date.now()
  await assert.rejects(() => route(STRANGER, 'repositories.list'))
  assert.ok(Date.now() - started < 1_000, 'a missing row is a lookup, not a network wait')
})

test('a local request goes through the dispatcher and comes back as a response', async () => {
  const response = await handleRoutedRequest({ id: 7, method: 'repositories.list' })

  assert.equal(response.id, 7)
  assert.ok('result' in response)
  assert.deepEqual(response.result, [])
})

test('a routed failure arrives as a message, never as a throw', async () => {
  // The carrier's contract: there is nowhere on a byte stream to put an
  // exception, so every outcome has to be a frame.
  const response = await handleRoutedRequest({
    id: 8,
    method: 'repositories.list',
    host: STRANGER
  })

  assert.equal(response.id, 8)
  assert.ok('error' in response)
  assert.equal(response.error.code, 'NOT_FOUND')
})

test('a host on the envelope does not reach the far end', async () => {
  // The strip is what stops a chain of hosts forming: what a host receives has
  // no host on it, so it answers rather than forwarding. Asserted here through
  // the one case that can be checked without a network - our own id, which is
  // routed locally and must not leave a `host` anywhere it could be read.
  const response = await handleRoutedRequest({
    id: 9,
    method: 'repositories.list',
    host: getInstanceId()
  })

  assert.ok('result' in response)
  assert.deepEqual(response.result, [])
  assert.ok(!('host' in response), 'a response is an answer, not an envelope going back out')
})
