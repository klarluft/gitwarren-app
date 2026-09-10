/**
 * That the Electron carrier still answers everything it used to.
 *
 * M1 replaced twenty-odd hand-written IPC handlers with one carrier channel and
 * a table. The risk in a change shaped like that is not that something breaks
 * loudly; it is that a channel quietly stops being registered and nobody finds
 * out, because the renderer no longer calls it. So the channels are accounted
 * for here: every name in `IPC_CHANNELS` has to be either a method, something
 * the shell answers itself, or a push - and never two of those at once.
 *
 * `main/ipc.ts` registers from the same table this reads, so a channel added
 * without a home fails here rather than at runtime.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// Set before the dispatcher is imported: nothing here opens the database, but a
// test must not be one edit away from writing to the real data directory.
const dataDir = mkdtempSync(join(tmpdir(), 'gitwarren-channels-'))
process.env.GITWARREN_DATA_DIR = dataDir

import { CHANNEL_METHODS, IPC_CHANNELS, PUSH_CHANNELS, SHELL_CHANNELS } from '../../shared/api.js'
import { rpcMethodNames } from '../../core/rpc/dispatcher.js'

after(() => rmSync(dataDir, { recursive: true, force: true }))

const methodChannels = Object.keys(CHANNEL_METHODS)

test('every channel has exactly one home', () => {
  for (const channel of Object.values(IPC_CHANNELS)) {
    // The carrier itself is the one channel that is none of the three.
    if (channel === IPC_CHANNELS.rpcRequest) continue

    const homes = [
      methodChannels.includes(channel),
      (SHELL_CHANNELS as readonly string[]).includes(channel),
      (PUSH_CHANNELS as readonly string[]).includes(channel)
    ].filter(Boolean).length

    assert.equal(homes, 1, `${channel} should be a method, a shell channel or a push - not ${homes}`)
  }
})

test('every channel that names a method names one that exists', () => {
  for (const [channel, method] of Object.entries(CHANNEL_METHODS)) {
    assert.ok(rpcMethodNames.includes(method), `${channel} points at a method that is gone: ${method}`)
  }
})

test('no two channels answer with the same method', () => {
  // Not fatal, but it would mean a channel was pointed at the wrong method
  // during a rename - and both would keep answering, one of them wrongly.
  const methods = Object.values(CHANNEL_METHODS)
  assert.equal(new Set(methods).size, methods.length)
})

test('the channels the shell keeps are the ones that touch this machine', () => {
  // Written out rather than derived, because the value of the list is that
  // adding to it is a decision someone has to make on purpose. A method that
  // could open a window or launch a program on a host across a network would
  // make GitWarren a very different piece of software - see the note at the top
  // of `core/rpc/dispatcher.ts`.
  assert.deepEqual([...SHELL_CHANNELS].sort(), [
    'attachments:pick',
    'reviews:openInEditor',
    'system:appInfo',
    'system:editors',
    'system:pickDirectory',
    'system:revealPath',
    'updates:check',
    'updates:getStatus',
    'updates:installNow'
  ])
})
