/**
 * The two names one file inside a distribution has.
 *
 * Worth testing as a pure function because both of its callers are places where
 * being wrong is expensive and silent: one decides whether to open an Explorer
 * window, and the other decides whether to refuse a repository. Neither can be
 * exercised on a Mac, and this can.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { windowsPathForWsl, wslPathFromWindows } from '../wsl.js'

test('a distro path becomes something Explorer can open', () => {
  assert.equal(
    windowsPathForWsl('Ubuntu', '/home/xfor/github.com/klarluft/gitwarren-app'),
    '\\\\wsl.localhost\\Ubuntu\\home\\xfor\\github.com\\klarluft\\gitwarren-app'
  )
  // The root of a distribution is a real place, and the one path with no tail.
  assert.equal(windowsPathForWsl('Ubuntu', '/'), '\\\\wsl.localhost\\Ubuntu')
})

test('both UNC spellings are recognised, and both separators', () => {
  const expected = { distro: 'Ubuntu', path: '/home/xfor/app' }

  // What Explorer and a paste from the address bar look like.
  assert.deepEqual(wslPathFromWindows('\\\\wsl.localhost\\Ubuntu\\home\\xfor\\app'), expected)
  // The older spelling, still resolving, still in people's bookmarks.
  assert.deepEqual(wslPathFromWindows('\\\\wsl$\\Ubuntu\\home\\xfor\\app'), expected)
  // What `git rev-parse --show-toplevel` hands back, which is the form the
  // guard is most likely to be shown and the one a backslash-only test misses.
  assert.deepEqual(wslPathFromWindows('//wsl.localhost/Ubuntu/home/xfor/app'), expected)
  // A UNC server name is case-insensitive and a path may have been through
  // anything on its way here.
  assert.deepEqual(wslPathFromWindows('\\\\WSL.LOCALHOST\\Ubuntu\\home\\xfor\\app'), expected)
})

test('the distribution root round-trips', () => {
  assert.deepEqual(wslPathFromWindows('\\\\wsl.localhost\\Ubuntu'), {
    distro: 'Ubuntu',
    path: '/'
  })
  assert.deepEqual(wslPathFromWindows('\\\\wsl.localhost\\Ubuntu\\'), {
    distro: 'Ubuntu',
    path: '/'
  })
})

test('anything that is not one of these is null, so a caller needs no second test', () => {
  assert.equal(wslPathFromWindows('C:\\Users\\micha\\app'), null)
  assert.equal(wslPathFromWindows('/home/xfor/app'), null)
  assert.equal(wslPathFromWindows('\\\\someserver\\share\\app'), null)
  // The prefix with no distribution after it names nothing.
  assert.equal(wslPathFromWindows('\\\\wsl.localhost'), null)
  assert.equal(wslPathFromWindows('\\\\wsl.localhost\\'), null)
  assert.equal(wslPathFromWindows(''), null)
})

test('a path out and back is the path it was', () => {
  const posix = '/home/xfor/github.com/klarluft/gitwarren-app'
  const round = wslPathFromWindows(windowsPathForWsl('Ubuntu', posix))

  assert.deepEqual(round, { distro: 'Ubuntu', path: posix })
})
