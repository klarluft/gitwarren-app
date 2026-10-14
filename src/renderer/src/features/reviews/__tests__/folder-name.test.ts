import assert from 'node:assert/strict'
import { test } from 'node:test'
import { folderName } from '../folder-name.js'

test('takes the last segment of a POSIX path', () => {
  assert.equal(folderName('/Users/me/app/.claude/worktrees/fix-login'), 'fix-login')
})

test('takes the last segment of a Windows path', () => {
  assert.equal(folderName('C:\\Users\\me\\src\\app-feature'), 'app-feature')
})

test('ignores a trailing separator', () => {
  assert.equal(folderName('/home/me/app/'), 'app')
  assert.equal(folderName('C:\\src\\app\\'), 'app')
})

test('keeps a path with no separator, and a bare root, as they are', () => {
  assert.equal(folderName('app'), 'app')
  assert.equal(folderName('/'), '/')
})
