/**
 * Coverage for the DOM-free parts of syntax highlighting: which grammar a file
 * gets, how a diff is laid out for the tokenizer, and how colours and search
 * hits are cut into the pieces a line is drawn with.
 *
 * The tokenizer itself is Shiki's and is not re-tested here. What is tested is
 * everything that decides whether its output lands on the right characters of
 * the right row - which is where a highlighting bug would actually show.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffBlocks, diffHighlighter } from '../highlight/diff-blocks.js'
import { languageForFence, languageForPath } from '../highlight/languages.js'
import { segmentLine } from '../highlight/segments.js'
import type { CodeToken } from '../highlight/tokenize.js'
import type { DiffLine } from '@shared/git'

function token(start: number, end: number, color = '#000'): CodeToken {
  return { start, end, color, fontStyle: 0 }
}

test('picks a grammar from the extension, case-insensitively', () => {
  assert.equal(languageForPath('src/app.tsx'), 'tsx')
  assert.equal(languageForPath('src/types.d.ts'), 'typescript')
  assert.equal(languageForPath('lib/Main.JAVA'), 'java')
  assert.equal(languageForPath('C:\\repo\\tool.py'), 'python')
})

test('picks a grammar from a whole file name before the extension', () => {
  assert.equal(languageForPath('Dockerfile'), 'docker')
  assert.equal(languageForPath('deploy/api.Dockerfile'), 'docker')
  assert.equal(languageForPath('Dockerfile.dev'), 'docker')
  assert.equal(languageForPath('CMakeLists.txt'), 'cmake')
  assert.equal(languageForPath('Makefile'), 'make')
  assert.equal(languageForPath('.env.local'), 'dotenv')
  assert.equal(languageForPath('tsconfig.json'), 'jsonc')
})

test('leaves files it has no grammar for plain', () => {
  assert.equal(languageForPath('README'), null)
  assert.equal(languageForPath('.gitignore'), null)
  assert.equal(languageForPath('notes.txt'), null)
  assert.equal(languageForPath('image.png'), null)
})

test('reads the language off a fence info string', () => {
  assert.equal(languageForFence('ts'), 'typescript')
  assert.equal(languageForFence('typescript'), 'typescript')
  assert.equal(languageForFence('bash'), 'shellscript')
  assert.equal(languageForFence('diff title="x"'), 'diff')
  assert.equal(languageForFence('C++'), 'cpp')
  assert.equal(languageForFence(''), null)
  assert.equal(languageForFence('mermaid'), null)
})

test('a line with no tokens and no hits is one plain piece', () => {
  assert.deepEqual(segmentLine('const x = 1', null, []), [
    { match: null, pieces: [{ text: 'const x = 1', token: null }] }
  ])
})

test('fills the gaps between tokens with plain text, covering the line once', () => {
  const keyword = token(0, 5)
  const number = token(10, 11)
  const [segment] = segmentLine('const x = 1;', [keyword, number], [])
  assert.deepEqual(
    segment?.pieces.map((piece) => [piece.text, piece.token]),
    [
      ['const', keyword],
      [' x = ', null],
      ['1', number],
      [';', null]
    ]
  )
})

test('a hit spanning two tokens is one mark that keeps both colours', () => {
  // `x = use` - starts in a plain stretch and ends inside a coloured call.
  const call = token(10, 13)
  const segments = segmentLine('const x = use()', [token(0, 5), call], [{ start: 6, end: 13 }])
  assert.deepEqual(
    segments.map((segment) => [segment.match, segment.pieces.map((piece) => piece.text)]),
    [
      [null, ['const', ' ']],
      [0, ['x = ', 'use']],
      [null, ['()']]
    ]
  )
  assert.equal(segments[1]?.pieces[1]?.token, call)
})

test('several hits inside one token cut it into pieces of the same colour', () => {
  const string = token(0, 10)
  const segments = segmentLine("'aa aa aa'", [string], [
    { start: 1, end: 3 },
    { start: 4, end: 6 }
  ])
  assert.deepEqual(
    segments.map((segment) => [segment.match, segment.pieces.map((piece) => piece.text)]),
    [
      [null, ["'"]],
      [0, ['aa']],
      [null, [' ']],
      [1, ['aa']],
      [null, [" aa'"]]
    ]
  )
  assert.ok(segments.slice(0, 4).every((segment) => segment.pieces[0]?.token === string))
})

test('tokens that run past the line or overlap are clamped, never repeat text', () => {
  const pieces = segmentLine('abc', [token(0, 2), token(1, 3), token(2, 9)], [])[0]?.pieces ?? []
  assert.equal(pieces.map((piece) => piece.text).join(''), 'abc')
})

const hunk: { lines: DiffLine[] } = {
  lines: [
    { type: 'context', content: 'a', oldNumber: 10, newNumber: 10 },
    { type: 'delete', content: 'old', oldNumber: 11, newNumber: null },
    { type: 'insert', content: 'new', oldNumber: null, newNumber: 11 },
    { type: 'insert', content: 'more', oldNumber: null, newNumber: 12 },
    { type: 'context', content: 'z', oldNumber: 12, newNumber: 13 }
  ]
}

test('lays each hunk out as its head side and its base side', () => {
  const layout = diffBlocks([hunk])
  assert.deepEqual(layout.blocks, [
    ['a', 'new', 'more', 'z'],
    ['a', 'old', 'z']
  ])
  assert.deepEqual(layout.numbers, [
    [10, 11, 12, 13],
    [10, 11, 12]
  ])
})

test('colours added rows from the head side and removed rows from the base side', () => {
  const layout = diffBlocks([hunk])
  const headTokens = [[token(0, 1, 'h-a')], [token(0, 3, 'h-new')], [], [token(0, 1, 'h-z')]]
  const baseTokens = [[token(0, 1, 'b-a')], [token(0, 3, 'b-old')], [token(0, 1, 'b-z')]]
  const find = diffHighlighter(layout, [headTokens, baseTokens], null)

  const [context, removed, added] = hunk.lines
  assert.equal(find(added!)?.[0]?.color, 'h-new')
  assert.equal(find(removed!)?.[0]?.color, 'b-old')
  // Context reads from the head side, the way the file now is.
  assert.equal(find(context!)?.[0]?.color, 'h-a')
})

test('prefers the whole file for head rows, but only where its text still matches', () => {
  const layout = diffBlocks([hunk])
  const headTokens = [[token(0, 1, 'hunk')], [token(0, 3, 'hunk')], [], [token(0, 1, 'hunk')]]
  const fileLines = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`)
  fileLines[9] = 'a' // line 10 matches the diff; line 11 does not
  const fileTokens = fileLines.map(() => [token(0, 1, 'file')])
  const find = diffHighlighter(layout, [headTokens, []], { lines: fileLines, tokens: fileTokens })

  const [context, , added] = hunk.lines
  assert.equal(find(context!)?.[0]?.color, 'file')
  assert.equal(find(added!)?.[0]?.color, 'hunk')
})

test('a row with nothing tokenized yet comes back null, not someone else’s colours', () => {
  const find = diffHighlighter(diffBlocks([hunk]), null, null)
  assert.equal(find(hunk.lines[2]!), null)
})
