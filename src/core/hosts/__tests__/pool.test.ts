/**
 * When there is a connection, and when there is deliberately not one.
 *
 * The pool is pure policy - it holds no sockets of its own and spawns nothing -
 * so it is tested with a fake connection and a clock the test moves by hand.
 * That is not a shortcut around testing the real thing: `ssh.ts` is what talks
 * to `ssh`, `stdio-client.ts` is what speaks the protocol, and both are covered
 * where they live. What is left here is the set of decisions that would
 * otherwise only ever be exercised by a laptop going to sleep at the wrong
 * moment.
 *
 * The one that matters most is the last test in the file. A `NOT_FOUND` and a
 * dead network both arrive at this code as a rejected promise, and treating
 * them alike would mark a perfectly healthy machine unreachable because someone
 * opened a review that had been deleted.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHostPool, BACKOFF_MS, type HostRoute } from '../pool.js'
import type { SshConnection } from '../ssh.js'
import { AppError } from '../../../shared/errors.js'

const route: HostRoute = { id: 1, kind: 'ssh', target: 'xfor@pc-wsl' }

interface FakeHost {
  /** How many times the pool has opened a connection. */
  connects: number
  /** What the next request should do. */
  answer: () => Promise<unknown>
  closeLast: (error: AppError) => void
  open: boolean
}

function fakePool(host: Partial<FakeHost> = {}): {
  pool: ReturnType<typeof createHostPool>
  fake: FakeHost
  advance: (ms: number) => void
} {
  let clock = 1_000_000
  const fake: FakeHost = {
    connects: 0,
    answer: () => Promise.resolve([]),
    closeLast: () => {},
    open: true,
    ...host
  }

  const pool = createHostPool({
    now: () => clock,
    connect: (_route, onClose) => {
      fake.connects += 1
      fake.open = true
      fake.closeLast = (error) => {
        fake.open = false
        onClose(error)
      }
      const connection: SshConnection = {
        request: () => fake.answer() as Promise<never>,
        close: () => {
          fake.open = false
        },
        isOpen: () => fake.open,
        diagnostics: () =>
          Promise.resolve('ssh: connect to host pc-wsl port 22: Host is down')
      }
      return connection
    }
  })

  return { pool, fake, advance: (ms: number) => (clock += ms) }
}

test('nothing connects until something is actually asked', () => {
  const { pool, fake } = fakePool()

  assert.equal(fake.connects, 0)
  assert.deepEqual(pool.state(route.id), { connected: false, failures: 0 })
})

test('one connection serves many requests', async () => {
  const { pool, fake } = fakePool()

  await pool.request(route, 'repositories.list')
  await pool.request(route, 'repositories.list')
  await pool.request(route, 'repositories.list')

  assert.equal(fake.connects, 1)
  assert.equal(pool.state(route.id).connected, true)
})

test('a failure puts the host into backoff, and requests inside it fail fast', async () => {
  const { pool, fake } = fakePool({
    answer: () => Promise.reject(new AppError('HOST_OFFLINE', 'gone'))
  })

  await assert.rejects(pool.request(route, 'repositories.list'))
  const afterFirst = pool.state(route.id)
  assert.equal(afterFirst.connected, false)
  assert.equal(afterFirst.failures, 1)
  // The diagnostics from the connection, not the bare protocol message: this is
  // what a Hosts screen shows, and "gone" would tell nobody anything.
  assert.match(afterFirst.lastError ?? '', /Host is down/)

  // The first rung is zero, so a second attempt is allowed immediately and the
  // second failure is what actually starts the timer.
  await assert.rejects(pool.request(route, 'repositories.list'))
  assert.equal(pool.state(route.id).failures, 2)
  const connectsSoFar = fake.connects

  // Now inside the backoff window. No new connection is attempted at all.
  await assert.rejects(pool.request(route, 'repositories.list'), /Host is down/)
  assert.equal(fake.connects, connectsSoFar, 'no ssh was spawned during backoff')
})

test('backoff expires, and a success clears it completely', async () => {
  const { pool, fake, advance } = fakePool({
    answer: () => Promise.reject(new AppError('HOST_OFFLINE', 'gone'))
  })

  await assert.rejects(pool.request(route, 'repositories.list'))
  await assert.rejects(pool.request(route, 'repositories.list'))
  const during = fake.connects

  advance(BACKOFF_MS[BACKOFF_MS.length - 1] ?? 60_000)
  fake.answer = () => Promise.resolve(['ok'])

  assert.deepEqual(await pool.request(route, 'repositories.list'), ['ok'])
  assert.ok(fake.connects > during, 'the wait having passed, it tried again')

  // A machine that is back is entirely back - not one rung down the ladder.
  assert.deepEqual(pool.state(route.id), { connected: true, failures: 0 })
})

test('a probe reaches past the backoff, because a person pressing a button knows more than a timer', async () => {
  const { pool, fake } = fakePool({
    answer: () => Promise.reject(new AppError('HOST_OFFLINE', 'gone'))
  })

  await assert.rejects(pool.request(route, 'repositories.list'))
  await assert.rejects(pool.request(route, 'repositories.list'))
  const during = fake.connects

  fake.answer = () => Promise.resolve([])
  const state = await pool.probe(route)

  assert.ok(fake.connects > during, 'the probe ignored the wait')
  assert.equal(state.connected, true)
})

test('a probe of a host that is down answers rather than throws', async () => {
  const { pool } = fakePool({
    answer: () => Promise.reject(new AppError('HOST_OFFLINE', 'gone'))
  })

  const state = await pool.probe(route)

  assert.equal(state.connected, false)
  assert.match(state.lastError ?? '', /Host is down/)
})

test('the connection dying on its own marks the host down', async () => {
  const { pool, fake } = fakePool()

  await pool.request(route, 'repositories.list')
  assert.equal(pool.state(route.id).connected, true)

  fake.closeLast(new AppError('HOST_OFFLINE', 'The connection to the host closed.'))

  assert.equal(pool.state(route.id).connected, false)
  assert.equal(pool.state(route.id).failures, 1)
})

test('hanging up on purpose is not a failure', async () => {
  const { pool } = fakePool()

  await pool.request(route, 'repositories.list')
  pool.disconnect(route.id)

  const state = pool.state(route.id)
  assert.equal(state.connected, false)
  // The distinction the idle timer depends on: a connection we closed must not
  // push the host onto the backoff ladder, or ten quiet minutes would look
  // exactly like a machine that had gone away.
  assert.equal(state.failures, 0)
  assert.equal(state.retryAfter, undefined)
})

test('an error from the host is the host working, not the host being down', async () => {
  const { pool } = fakePool({
    answer: () => Promise.reject(new AppError('NOT_FOUND', 'No review with id 999.'))
  })

  await assert.rejects(pool.request(route, 'reviews.get'), (error: AppError) => {
    // Passed through untouched - a caller must not have to unwrap a transport
    // error to find out that a review does not exist.
    assert.equal(error.code, 'NOT_FOUND')
    return true
  })

  // The round trip succeeded. The machine is fine and stays fine.
  assert.deepEqual(pool.state(route.id), { connected: true, failures: 0 })
})

test('a pipe that dies under a request is one failure, not two', async () => {
  // This is the shape a real `ssh` has and the fake above did not: when the far
  // end goes, the close handler fires *and* every request waiting on it
  // rejects. Counting both made one press of "Try now" climb two rungs of the
  // backoff ladder, so a machine that was switched off went from a one-second
  // wait to a fifteen-second one after two attempts instead of four. Found
  // against `pc-wsl` while verifying M4.2, by reading a `failures: 2` that
  // should have said 1.
  const { pool, fake } = fakePool({
    answer: () =>
      new Promise((_resolve, reject) => {
        fake.closeLast(new AppError('HOST_OFFLINE', 'The connection to the host closed.'))
        reject(new AppError('HOST_OFFLINE', 'The connection to the host closed.'))
      })
  })

  await assert.rejects(pool.request(route, 'repositories.list'))

  const state = pool.state(route.id)
  assert.equal(state.failures, 1)
  // And the explanation is the one that waited for `ssh` to exit, not the one
  // that was all anybody knew at the instant stdout ended. The count takes the
  // earliest, the message takes the latest.
  assert.match(state.lastError ?? '', /Host is down/)
  // First rung, because this was the first failure.
  assert.equal(state.retryAfter, undefined)

  // And the ladder still climbs on the next one.
  await assert.rejects(pool.request(route, 'repositories.list'))
  assert.equal(pool.state(route.id).failures, 2)
  assert.equal(typeof pool.state(route.id).retryAfter, 'number')
})

test('a second failure on the same dead connection is still one rung', async () => {
  // Two requests in flight when the pipe goes is one event, not two, and a
  // screen that had opened a review and a diff at once must not be punished
  // twice for one network blip.
  const { pool, fake } = fakePool({
    answer: () =>
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new AppError('HOST_OFFLINE', 'gone')), 0)
      )
  })

  const first = pool.request(route, 'repositories.list')
  const second = pool.request(route, 'reviews.list')
  fake.closeLast(new AppError('HOST_OFFLINE', 'The connection to the host closed.'))

  await assert.rejects(first)
  await assert.rejects(second)

  assert.equal(pool.state(route.id).failures, 1)
})

test('a fresh connection that fails is a new rung, not a repeat of the old one', async () => {
  const { pool, fake, advance } = fakePool({
    answer: () => Promise.reject(new AppError('HOST_OFFLINE', 'gone'))
  })

  await assert.rejects(pool.request(route, 'repositories.list'))
  assert.equal(pool.state(route.id).failures, 1)

  // Past the first rung, so a new connection is opened - and its failure has to
  // count, or a host that is down would sit at one failure forever.
  advance(BACKOFF_MS[1] + 1)
  await assert.rejects(pool.request(route, 'repositories.list'))
  assert.equal(pool.state(route.id).failures, 2)
  assert.equal(fake.connects, 2)
})
