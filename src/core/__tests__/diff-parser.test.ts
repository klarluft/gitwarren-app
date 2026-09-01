/**
 * Unit coverage for the patch parser.
 *
 * These are the shapes that a line-oriented parser tends to get wrong, all of
 * which git produces routinely: a rename carrying no hunks at all, paths with
 * spaces in them, quoted non-ASCII paths, and binary files.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUntrackedFileDiff, parseUnifiedDiff, unquotePath } from '../diff-parser.js'

test('parses a modification with line numbers on both sides', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    'index 1234567..89abcde 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,4 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '+four',
    ''
  ].join('\n')

  const [file] = parseUnifiedDiff(patch)
  assert.ok(file)
  assert.equal(file.path, 'a.txt')
  assert.equal(file.status, 'modified')
  assert.equal(file.additions, 2)
  assert.equal(file.deletions, 1)

  const lines = file.hunks[0]?.lines ?? []
  assert.deepEqual(
    lines.map((line) => [line.type, line.oldNumber, line.newNumber]),
    [
      ['context', 1, 1],
      ['delete', 2, null],
      ['insert', null, 2],
      ['context', 3, 3],
      ['insert', null, 4]
    ]
  )
})

test('a new file is reported as added', () => {
  const patch = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 0000000..1234567',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
    ''
  ].join('\n')

  const [file] = parseUnifiedDiff(patch)
  assert.equal(file?.status, 'added')
  assert.equal(file?.path, 'new.txt')
  assert.equal(file?.additions, 2)
})

test('a deletion keeps the path it used to have', () => {
  const patch = [
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    'index 1234567..0000000',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-was here',
    ''
  ].join('\n')

  const [file] = parseUnifiedDiff(patch)
  assert.equal(file?.status, 'deleted')
  assert.equal(file?.path, 'gone.txt')
  assert.equal(file?.deletions, 1)
})

test('a pure rename has no hunks but still names both paths', () => {
  const patch = [
    'diff --git a/old/name.ts b/new/name.ts',
    'similarity index 100%',
    'rename from old/name.ts',
    'rename to new/name.ts',
    ''
  ].join('\n')

  const [file] = parseUnifiedDiff(patch)
  assert.equal(file?.status, 'renamed')
  assert.equal(file?.oldPath, 'old/name.ts')
  assert.equal(file?.path, 'new/name.ts')
  assert.equal(file?.hunks.length, 0)
})

test('paths containing spaces survive', () => {
  const patch = [
    'diff --git a/my notes.md b/my notes.md',
    'index 1234567..89abcde 100644',
    '--- a/my notes.md',
    '+++ b/my notes.md',
    '@@ -1 +1 @@',
    '-before',
    '+after',
    ''
  ].join('\n')

  const [file] = parseUnifiedDiff(patch)
  assert.equal(file?.path, 'my notes.md')
})

test('binary files are flagged rather than parsed', () => {
  const patch = [
    'diff --git a/logo.png b/logo.png',
    'index 1234567..89abcde 100644',
    'Binary files a/logo.png and b/logo.png differ',
    ''
  ].join('\n')

  const [file] = parseUnifiedDiff(patch)
  assert.equal(file?.isBinary, true)
  assert.equal(file?.hunks.length, 0)
})

test('several files in one patch are kept apart', () => {
  const patch = [
    'diff --git a/one.txt b/one.txt',
    '--- a/one.txt',
    '+++ b/one.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/two.txt b/two.txt',
    '--- a/two.txt',
    '+++ b/two.txt',
    '@@ -1 +1 @@',
    '-c',
    '+d',
    ''
  ].join('\n')

  const files = parseUnifiedDiff(patch)
  assert.deepEqual(
    files.map((file) => file.path),
    ['one.txt', 'two.txt']
  )
  assert.equal(files[1]?.additions, 1)
})

test('"no newline at end of file" is not counted as a change', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-one',
    '\\ No newline at end of file',
    '+one!',
    '\\ No newline at end of file',
    ''
  ].join('\n')

  const [file] = parseUnifiedDiff(patch)
  assert.equal(file?.additions, 1)
  assert.equal(file?.deletions, 1)
  assert.equal(file?.hunks[0]?.lines.length, 2)
})

test('an enormous patch is clipped but still counted honestly', () => {
  const body = Array.from({ length: 50 }, (_, index) => `+line ${index}`).join('\n')
  const patch = [
    'diff --git a/big.txt b/big.txt',
    '--- a/big.txt',
    '+++ b/big.txt',
    '@@ -0,0 +1,50 @@',
    body,
    ''
  ].join('\n')

  const [file] = parseUnifiedDiff(patch, { maxLinesPerFile: 10 })
  assert.equal(file?.truncated, true)
  assert.equal(file?.hunks[0]?.lines.length, 10)
  // The summary still reflects the whole file, not just what was kept.
  assert.equal(file?.additions, 50)
})

test('git-quoted paths are decoded back to their real name', () => {
  assert.equal(unquotePath('"caf\\303\\251.txt"'), 'café.txt')
  assert.equal(unquotePath('"with \\"quotes\\".txt"'), 'with "quotes".txt')
  assert.equal(unquotePath('plain.txt'), 'plain.txt')
})

test('an untracked file becomes a whole-file addition', () => {
  const file = buildUntrackedFileDiff('new.txt', 'alpha\nbeta\n', { isBinary: false })

  assert.equal(file.status, 'added')
  assert.equal(file.isUntracked, true)
  assert.equal(file.hasUncommittedChanges, true)
  // The trailing newline terminates the last line, it does not add an empty one.
  assert.equal(file.additions, 2)
  assert.deepEqual(
    file.hunks[0]?.lines.map((line) => line.content),
    ['alpha', 'beta']
  )
})

test('an untracked binary file is listed without content', () => {
  const file = buildUntrackedFileDiff('logo.png', '', { isBinary: true })

  assert.equal(file.isBinary, true)
  assert.equal(file.hunks.length, 0)
  assert.equal(file.additions, 0)
})
