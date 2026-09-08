import { deepStrictEqual, notStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DIGEST_MAX_LENGTH, fileDiffDigest } from '../diff-digest.js'
import type { DiffLine, FileDiff } from '../git.js'

function line(type: DiffLine['type'], content: string, oldNumber: number | null, newNumber: number | null): DiffLine {
  return { type, content, oldNumber, newNumber }
}

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: 'src/app.ts',
    oldPath: null,
    status: 'modified',
    isBinary: false,
    additions: 1,
    deletions: 1,
    truncated: false,
    isUntracked: false,
    hasUncommittedChanges: false,
    hunks: [
      {
        header: '@@ -1,3 +1,3 @@',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          line('context', 'const a = 1', 1, 1),
          line('delete', 'const b = 2', 2, null),
          line('insert', 'const b = 3', null, 2)
        ]
      }
    ],
    ...overrides
  }
}

describe('fileDiffDigest', () => {
  it('is stable for the same diff', () => {
    strictEqual(fileDiffDigest(fileDiff()), fileDiffDigest(fileDiff()))
  })

  it('fits the column it is stored in', () => {
    ok(fileDiffDigest(fileDiff()).length <= DIGEST_MAX_LENGTH)
  })

  it('changes when a line of code changes', () => {
    const edited = fileDiff()
    edited.hunks[0]!.lines[2] = line('insert', 'const b = 4', null, 2)
    notStrictEqual(fileDiffDigest(fileDiff()), fileDiffDigest(edited))
  })

  it('changes when a line is added to the diff', () => {
    const grown = fileDiff()
    grown.hunks[0]!.lines.push(line('insert', 'const c = 5', null, 3))
    notStrictEqual(fileDiffDigest(fileDiff()), fileDiffDigest(grown))
  })

  it('changes when the same lines move, so a mark does not survive an edit above', () => {
    const moved = fileDiff({
      hunks: [{ ...fileDiff().hunks[0]!, header: '@@ -8,3 +9,3 @@' }]
    })
    notStrictEqual(fileDiffDigest(fileDiff()), fileDiffDigest(moved))
  })

  it('changes when a line is only reclassified', () => {
    const staged = fileDiff()
    staged.hunks[0]!.lines[0] = line('insert', 'const a = 1', null, 1)
    notStrictEqual(fileDiffDigest(fileDiff()), fileDiffDigest(staged))
  })

  it('changes when the file is renamed', () => {
    notStrictEqual(
      fileDiffDigest(fileDiff()),
      fileDiffDigest(fileDiff({ status: 'renamed', oldPath: 'src/old.ts' }))
    )
  })

  it('tells two files with identical content apart', () => {
    notStrictEqual(fileDiffDigest(fileDiff()), fileDiffDigest(fileDiff({ path: 'src/other.ts' })))
  })

  it('notices a binary file changing, which has no hunks to compare', () => {
    const before = fileDiff({ isBinary: true, hunks: [], additions: 0, deletions: 0 })
    const after = fileDiff({ isBinary: true, hunks: [], additions: 4, deletions: 2 })
    notStrictEqual(fileDiffDigest(before), fileDiffDigest(after))
  })

  it('ignores state that is not part of the diff being read', () => {
    // Whether the change happens to be committed yet does not alter a single
    // line on screen, so a mark should survive committing the work.
    strictEqual(
      fileDiffDigest(fileDiff()),
      fileDiffDigest(fileDiff({ hasUncommittedChanges: true }))
    )
  })

  it('cannot be fooled by content that runs across field boundaries', () => {
    const digests = [
      fileDiffDigest(fileDiff({ path: 'a b', oldPath: null })),
      fileDiffDigest(fileDiff({ path: 'a', oldPath: 'b' })),
      fileDiffDigest(fileDiff({ path: 'a', oldPath: null }))
    ]
    deepStrictEqual(new Set(digests).size, digests.length)
  })
})
