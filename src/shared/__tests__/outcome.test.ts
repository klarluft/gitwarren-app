/**
 * An error, as a value.
 *
 * `outcomeOf` and `resultOf` are the two halves of the one rule every boundary
 * in this app that cannot carry an exception follows: report how it went as a
 * *value*, and turn it back into a throw on the other side. The stdio and
 * WebSocket carriers have always done this because a byte stream leaves no
 * choice. Electron's `contextBridge` turned out to be the same kind of boundary
 * without looking like one - it rebuilds a rejection as a bare `Error` carrying
 * `message` and nothing else - which is what made `errorCode(error)` always
 * null in the packaged window and sent every inline form message to the banner.
 *
 * So what is pinned here is the part that was being lost: the code and the
 * field errors, through a full round trip. A test cannot run `contextBridge`,
 * but it can hold still the property that makes crossing it survivable, and the
 * real crossing was checked by hand against the running app.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AppError } from '../errors.js'
import { outcomeOf, resultOf } from '../rpc.js'

/** What a failed round trip leaves you holding. */
async function roundTrip(work: () => Promise<unknown>): Promise<unknown> {
  const outcome = await outcomeOf(work)
  try {
    return resultOf(outcome)
  } catch (error) {
    return error
  }
}

test('a value comes back as itself', async () => {
  const outcome = await outcomeOf(() => Promise.resolve({ id: 4, name: 'app' }))

  assert.deepEqual(outcome, { result: { id: 4, name: 'app' } })
  assert.deepEqual(resultOf(outcome), { id: 4, name: 'app' })
})

test('the code survives, which is the whole point', async () => {
  const thrown = await roundTrip(() =>
    Promise.reject(new AppError('HOST_OFFLINE', 'xfor@pc-wsl is not reachable.'))
  )

  assert.ok(thrown instanceof AppError)
  assert.equal(thrown.code, 'HOST_OFFLINE')
  assert.equal(thrown.message, 'xfor@pc-wsl is not reachable.')
})

test('field errors survive, which is what puts a message under an input', async () => {
  // The case that was visibly broken: adding a repository that is already
  // tracked reported itself in the dialog's banner rather than under the path
  // field, because this object did not cross.
  const thrown = await roundTrip(() =>
    Promise.reject(
      new AppError('DUPLICATE_REPOSITORY', 'That repository is already tracked.', {
        path: ['Already tracked as "gitwarren-app".']
      })
    )
  )

  assert.ok(thrown instanceof AppError)
  assert.equal(thrown.code, 'DUPLICATE_REPOSITORY')
  assert.deepEqual(thrown.fieldErrors, { path: ['Already tracked as "gitwarren-app".'] })
})

test('an ordinary Error becomes INTERNAL rather than being lost', async () => {
  const thrown = await roundTrip(() => Promise.reject(new TypeError('cannot read x of undefined')))

  assert.ok(thrown instanceof AppError)
  assert.equal(thrown.code, 'INTERNAL')
  assert.equal(thrown.message, 'cannot read x of undefined')
})

test('a synchronous throw is an outcome too, not an escape', async () => {
  // `outcomeOf` takes a function rather than a promise precisely so that a
  // caller that throws before returning one is still reported as a value. A
  // signature taking a promise would let that case past the boundary.
  const outcome = await outcomeOf(() => {
    throw new AppError('INVALID_INPUT', 'An image is required.')
  })

  assert.ok('error' in outcome)
  assert.equal(outcome.error.code, 'INVALID_INPUT')
})
