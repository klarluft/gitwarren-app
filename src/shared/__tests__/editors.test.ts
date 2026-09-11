/**
 * Coverage for the editor URLs, which are now opened by two shells.
 *
 * The Electron app hands these to `shell.openExternal` and a browser tab
 * navigates to them; either way what the operating system receives is this
 * string, and it is the only part of "open this file at this line" that is not
 * observable from inside GitWarren - the editor either lands on the line or it
 * does not, somewhere else entirely. Spike S4 in docs/across-hosts.md is where
 * these forms were checked against real editors; this is what stops them being
 * edited into something else afterwards.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EDITOR_LINKS,
  editorLink,
  editorTargetFor,
  linkableEditors,
  opensRemotely,
  remotelyOpenable
} from '../editors.js'

test('the URL forms are the ones spike S4 landed on', () => {
  const path = '/home/xfor/github.com/klarluft/gitwarren-app/README.md'

  assert.equal(editorLink('vscode')?.url?.(path, 5), `vscode://file${path}:5`)
  assert.equal(editorLink('cursor')?.url?.(path, 5), `cursor://file${path}:5`)
  assert.equal(
    editorLink('sublime')?.url?.(path, 5),
    `subl://open?url=file://${encodeURIComponent(path)}&line=5`
  )
})

test('a path with a space in it is escaped rather than truncated', () => {
  // The failure this prevents is silent: an unescaped space ends the URL, and
  // the editor opens the first half of the path or nothing at all.
  const url = editorLink('vscode')?.url?.('/Users/me/My Projects/app/src/index.ts', 12)

  assert.equal(url, 'vscode://file/Users/me/My%20Projects/app/src/index.ts:12')
})

test('an editor nobody asked for is not invented', () => {
  assert.equal(editorLink('emacs'), undefined)
  assert.equal(editorLink(undefined), undefined)
})

test('a shell that can only navigate is offered every editor with a scheme', () => {
  const offered = linkableEditors()

  // JetBrains is launched by `idea --line` and has nothing to navigate to, so
  // it is the one entry a browser tab does not get.
  assert.deepEqual(
    offered.map((editor) => editor.id),
    ['vscode', 'cursor', 'windsurf', 'zed', 'sublime']
  )
  assert.equal(
    offered.length,
    EDITOR_LINKS.length - 1,
    'an editor was added without deciding whether a browser can open it'
  )
})

/* -------------------------------------------------------------------------- */
/* Files on another machine                                                   */
/* -------------------------------------------------------------------------- */

test('the remote URL form names the machine before the path', () => {
  const path = '/home/xfor/repos/app/README.md'
  const remote = 'ssh-remote+xfor@pc-wsl'

  assert.equal(
    editorLink('vscode')?.remoteUrl?.(remote, path, 5),
    `vscode://vscode-remote/${remote}${path}:5`
  )
  assert.equal(
    editorLink('cursor')?.remoteUrl?.(remote, path, 5),
    `cursor://vscode-remote/${remote}${path}:5`
  )
})

test('the authority keeps the punctuation an ssh target is made of', () => {
  // `@` and `+` are legal in a path segment and are what the authority is
  // spelled with; percent-encoding them produces a machine name no remote
  // extension recognises, and the failure is a window that opens on nothing.
  const url = editorLink('vscode')?.remoteUrl?.('ssh-remote+xfor@pc-wsl', '/home/xfor/a.ts', 1)

  assert.ok(url?.includes('ssh-remote+xfor@pc-wsl'), url ?? 'no remote URL at all')
})

test('a remote path with a space in it is escaped the same way a local one is', () => {
  const url = editorLink('vscode')?.remoteUrl?.('wsl+Ubuntu', '/home/xfor/My Work/a.ts', 3)

  assert.equal(url, 'vscode://vscode-remote/wsl+Ubuntu/home/xfor/My%20Work/a.ts:3')
})

test('an editor with no way to reach another machine says so', () => {
  // Zed, Sublime and the JetBrains IDEs have no remote form here. Offering one
  // of them for a remote review is how a Mac editor is handed a path only WSL
  // has, which is the failure M4.3 hid the whole control to avoid.
  assert.equal(opensRemotely('vscode'), true)
  assert.equal(opensRemotely('cursor'), true)
  assert.equal(opensRemotely('windsurf'), true)
  assert.equal(opensRemotely('zed'), false)
  assert.equal(opensRemotely('sublime'), false)
  assert.equal(opensRemotely('jetbrains'), false)
})

test('GITWARREN_EDITOR is trusted to know what it is doing', () => {
  // `{host}` exists in the template precisely so that somebody can say what
  // "over there" means for their own command. Whether it works is theirs to
  // find out; refusing to offer it would remove the only way to try.
  assert.equal(opensRemotely('custom'), true)
})

test('a remote picker offers only what can actually open a remote file', () => {
  const filtered = remotelyOpenable({
    editors: [
      { id: 'zed', label: 'Zed' },
      { id: 'vscode', label: 'VS Code' }
    ],
    defaultId: 'zed'
  })

  // The default moves too. Leaving it pointing at Zed would produce a picker
  // whose selected entry is not in it.
  assert.deepEqual(filtered.editors, [{ id: 'vscode', label: 'VS Code' }])
  assert.equal(filtered.defaultId, 'vscode')
})

test('a machine with nothing that can reach a host gets an empty list', () => {
  const filtered = remotelyOpenable({ editors: [{ id: 'zed', label: 'Zed' }], defaultId: 'zed' })

  // Which is what makes the button disappear rather than open the wrong file.
  assert.deepEqual(filtered.editors, [])
  assert.equal(filtered.defaultId, null)
})

test('a chosen default that can reach a host is kept', () => {
  const filtered = remotelyOpenable({
    editors: [
      { id: 'vscode', label: 'VS Code' },
      { id: 'cursor', label: 'Cursor' }
    ],
    defaultId: 'cursor'
  })

  assert.equal(filtered.defaultId, 'cursor')
})

test('the editor target is derived from the ssh target, and overridden when set', () => {
  assert.equal(
    editorTargetFor({ kind: 'ssh', target: 'xfor@pc-wsl', editorTarget: null }),
    'ssh-remote+xfor@pc-wsl'
  )
  // NULL means derive; a value means somebody's SSH config and their editor
  // disagree, and theirs wins. M5 is where the two stop coinciding by default.
  assert.equal(
    editorTargetFor({ kind: 'ssh', target: 'xfor@pc-wsl', editorTarget: 'wsl+Ubuntu' }),
    'wsl+Ubuntu'
  )
})
