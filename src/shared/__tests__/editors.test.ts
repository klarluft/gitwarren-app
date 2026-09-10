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
import { EDITOR_LINKS, editorLink, linkableEditors } from '../editors.js'

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
