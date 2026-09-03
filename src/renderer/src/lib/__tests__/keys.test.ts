/**
 * Coverage for the binding notation.
 *
 * The cases here are the ones that decide whether a shortcut fires at all:
 * modifier order, the two meanings of shift, and `mod` resolving to a different
 * physical key on each platform.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindingSteps, eventToken, formatBinding, formatStep, normalizeStep } from '../keys.js'

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
