/**
 * Coverage for the binding notation.
 *
 * The cases here are the ones that decide whether a shortcut fires at all:
 * modifier order, the two meanings of shift, and `mod` resolving to a different
 * physical key on each platform.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bindingSteps,
  eventToken,
  formatBinding,
  formatStep,
  isTextEditingToken,
  normalizeStep
} from '../keys.js'

function press(
  key: string,
  modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}
): { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean } {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers
  }
}

test('normalizes modifier order so one keystroke has one spelling', () => {
  assert.equal(normalizeStep('shift+mod+K'), 'mod+shift+k')
  assert.equal(normalizeStep('mod+shift+k'), 'mod+shift+k')
})

test('splits a chord into its steps', () => {
  assert.deepEqual(bindingSteps('g h'), ['g', 'h'])
  assert.deepEqual(bindingSteps('mod+k'), ['mod+k'])
})

test('mod is Command on macOS and Control elsewhere', () => {
  assert.equal(eventToken(press('k', { metaKey: true }), 'mac'), 'mod+k')
  assert.equal(eventToken(press('k', { ctrlKey: true }), 'other'), 'mod+k')
})

test('the other modifier stays reachable on each platform', () => {
  // Control on a Mac is a real modifier of its own, not a stand-in for Command.
  assert.equal(eventToken(press('a', { ctrlKey: true }), 'mac'), 'ctrl+a')
  assert.equal(eventToken(press('a', { metaKey: true }), 'other'), 'meta+a')
})

test('shift modifies a letter but is absorbed into punctuation', () => {
  assert.equal(eventToken(press('N', { shiftKey: true }), 'mac'), 'shift+n')
  // `?` is Shift+/ on a US layout; the browser already reports the `?`.
  assert.equal(eventToken(press('?', { shiftKey: true }), 'mac'), '?')
})

test('a bare modifier press is not a keystroke', () => {
  assert.equal(eventToken(press('Meta', { metaKey: true }), 'mac'), null)
  assert.equal(eventToken(press('Shift', { shiftKey: true }), 'mac'), null)
})

test('renders Mac symbols run together and other platforms with pluses', () => {
  assert.equal(formatStep('mod+k', 'mac'), '⌘K')
  assert.equal(formatStep('mod+k', 'other'), 'Ctrl+K')
  assert.equal(formatStep('mod+shift+p', 'mac'), '⌘⇧P')
  assert.equal(formatStep('escape', 'other'), 'Esc')
})

test('a chord renders as one step per key', () => {
  assert.deepEqual(formatBinding('g h', 'mac'), ['G', 'H'])
})

test('caret keys belong to the text field under every modifier', () => {
  const owned = [
    'arrowleft',
    'mod+arrowleft',
    'mod+arrowright',
    'alt+arrowleft',
    'mod+shift+arrowleft',
    'mod+arrowup',
    'home',
    'mod+end',
    'backspace',
    'alt+backspace',
    'mod+delete',
    'pageup'
  ]
  for (const token of owned) {
    assert.equal(isTextEditingToken(token, 'mac'), true, token)
  }
})

test('clipboard and undo belong to the text field on either platform', () => {
  for (const platform of ['mac', 'other'] as const) {
    for (const key of ['a', 'c', 'v', 'x', 'z', 'y']) {
      assert.equal(isTextEditingToken('mod+' + key, platform), true, 'mod+' + key)
    }
    assert.equal(isTextEditingToken('mod+shift+z', platform), true)
  }
})

test('the emacs bindings belong to the text field only on macOS', () => {
  assert.equal(isTextEditingToken('ctrl+a', 'mac'), true)
  assert.equal(isTextEditingToken('ctrl+k', 'mac'), true)
  assert.equal(isTextEditingToken('ctrl+e', 'mac'), true)
  // Off a Mac the same physical key reads as `mod`, and a literal control
  // press is not a text command anywhere else.
  assert.equal(isTextEditingToken('ctrl+a', 'other'), false)
})

test('the app keeps the shortcuts a text field has no use for', () => {
  const free = ['mod+k', 'mod+[', 'mod+]', 'mod+enter', 'mod+b', 'mod+i', 'g', '?']
  for (const token of free) {
    assert.equal(isTextEditingToken(token, 'mac'), false, token)
  }
})
