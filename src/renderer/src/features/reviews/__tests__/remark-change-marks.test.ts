/**
 * Coverage for turning change marks into `<ins>` and `<del>` after parsing.
 *
 * Run through the real parser rather than against hand-built trees, because
 * the interesting cases are exactly where Markdown syntax and a mark meet: a
 * mark that opens in plain text and closes inside bold, and a mark next to
 * emphasis that has to still be emphasis.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toHast } from 'mdast-util-to-hast'
import { toHtml } from 'hast-util-to-html'
import { SENTINELS } from '../markdown-diff.js'
import { remarkChangeMarks } from '../remark-change-marks.js'

const { insertOpen: I, insertClose: i, deleteOpen: D, deleteClose: d } = SENTINELS

function render(source: string): string {
  const tree = fromMarkdown(source)
  remarkChangeMarks()(tree)
  return toHtml(toHast(tree))
    .replace(/ class="[^"]*"/g, '')
}

test('marked words become ins and del', () => {
  assert.equal(render(`The ${D}mat${d}${I}rug${i}.`), '<p>The <del>mat</del><ins>rug</ins>.</p>')
})

test('a mark that runs into bold text wraps each piece, and the bold survives', () => {
  assert.equal(render(`${I}new **bold**${i} end`), '<p><ins>new </ins><strong><ins>bold</ins></strong> end</p>')
})

test('emphasis next to a mark still parses as emphasis', () => {
  assert.equal(render(`*a ${I}word${i}*`), '<p><em>a <ins>word</ins></em></p>')
})

test('a code span inside a mark is wrapped whole', () => {
  assert.equal(render(`${I}\`x\`${i}`), '<p><ins><code>x</code></ins></p>')
})

test('no stray marks survive into the output', () => {
  assert.ok(!/[-]/.test(render(`${I}[link](https://example.com)${i} ${D}![alt](a.png)${d}`)))
})
