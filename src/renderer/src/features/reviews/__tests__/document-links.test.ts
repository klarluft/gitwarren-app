/**
 * Coverage for following links and images in a repository's Markdown files.
 *
 * Paths are resolved the way GitHub resolves them - relative to the file, or
 * to the repository root after a `/` - and nothing is allowed to climb out of
 * the repository. The remark plugins are run through the real parser, because
 * an `<img>` tag reaches them as whatever kind of HTML node CommonMark decided
 * it was.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toHast } from 'mdast-util-to-hast'
import { toHtml } from 'hast-util-to-html'
import { documentLink, fileForLink, resolveDocumentPath } from '../document-links.js'
import { headingDomId, headingSlug, remarkHeadingIds, remarkHtmlImages } from '../remark-document.js'

test('a relative path is resolved against the document', () => {
  assert.equal(resolveDocumentPath('docs/guide.md', 'img/a.png'), 'docs/img/a.png')
  assert.equal(resolveDocumentPath('docs/guide.md', './img/a.png'), 'docs/img/a.png')
  assert.equal(resolveDocumentPath('docs/guide.md', '../logo.png'), 'logo.png')
  assert.equal(resolveDocumentPath('README.md', 'my%20pic.png'), 'my pic.png')
})

test('a leading slash is the repository root, as on GitHub', () => {
  assert.equal(resolveDocumentPath('docs/deep/guide.md', '/assets/a.png'), 'assets/a.png')
})

test('URLs, fragments and paths out of the repository are not repository paths', () => {
  assert.equal(resolveDocumentPath('README.md', 'https://example.com/a.png'), null)
  assert.equal(resolveDocumentPath('README.md', '//example.com/a.png'), null)
  assert.equal(resolveDocumentPath('README.md', '#top'), null)
  assert.equal(resolveDocumentPath('README.md', '../outside.md'), null)
})

test('links are sorted into anchors, files, URLs and nowhere', () => {
  assert.deepEqual(documentLink('docs/a.md', '#setup'), { kind: 'anchor', fragment: 'setup' })
  assert.deepEqual(documentLink('docs/a.md', 'b.md'), { kind: 'file', path: 'docs/b.md', fragment: null })
  assert.deepEqual(documentLink('docs/a.md', '../README.md#install'), {
    kind: 'file',
    path: 'README.md',
    fragment: 'install'
  })
  assert.deepEqual(documentLink('docs/a.md', 'mailto:me@example.com'), { kind: 'external' })
  assert.deepEqual(documentLink('docs/a.md', '../../x.md'), { kind: 'outside' })
})

test('a link to the same file at a heading is an anchor', () => {
  assert.deepEqual(documentLink('docs/a.md', 'a.md#costs'), { kind: 'anchor', fragment: 'costs' })
})

test('a folder opens its README', () => {
  const paths = ['README.md', 'docs/README.md', 'docs/guide.md', 'docs/deep/README.md']
  assert.equal(fileForLink(paths, 'docs/guide.md'), 'docs/guide.md')
  assert.equal(fileForLink(paths, 'docs'), 'docs/README.md')
  assert.equal(fileForLink(paths, 'nowhere'), 'nowhere')
})

test('heading slugs match the anchors GitHub writes', () => {
  assert.equal(headingSlug('Getting Started'), 'getting-started')
  assert.equal(headingSlug('What’s new in v0.2?'), 'whats-new-in-v02')
  assert.equal(headingSlug('Über  uns'), 'über--uns')
  assert.equal(headingDomId('Getting-Started'), 'doc-getting-started')
  assert.equal(headingDomId('%C3%BCber'), 'doc-über')
})

function render(source: string): string {
  const tree = fromMarkdown(source)
  remarkHtmlImages()(tree)
  remarkHeadingIds()(tree)
  return toHtml(toHast(tree))
}

test('headings carry their slug as an id', () => {
  assert.equal(render('## Install `gitwarren`'), '<h2 id="doc-install-gitwarren">Install <code>gitwarren</code></h2>')
})

test('a block of HTML around an img becomes a paragraph with the image', () => {
  assert.equal(
    render('<p align="center">\n  <img src="docs/logo.png" alt="Logo" width="200">\n</p>'),
    '<p><img src="docs/logo.png" alt="Logo" width="200"></p>'
  )
})

test('an inline img tag becomes an image in its paragraph', () => {
  assert.equal(render("See <img src='a.png'> here"), '<p>See <img src="a.png" alt=""> here</p>')
})

test('an img inside an HTML link becomes an image inside a link', () => {
  assert.equal(
    render('<a href="https://gitwarren.com"><img src="docs/a.png" alt="A" width="800" /></a>'),
    '<p><a href="https://gitwarren.com"><img src="docs/a.png" alt="A" width="800"></a></p>'
  )
})

test('a block of HTML keeps the link around its image', () => {
  assert.equal(
    render('<p align="center">\n  <a href="docs/guide.md"><img src="logo.png"></a>\n</p>'),
    '<p><a href="docs/guide.md"><img src="logo.png" alt=""></a></p>'
  )
})

test('an HTML link around Markdown text is a link, and a name-only anchor disappears', () => {
  assert.equal(render('<a name="top"></a>See <a href="b.md">the *other* file</a>.'), '<p>See <a href="b.md">the <em>other</em> file</a>.</p>')
})

test('HTML without an image is still not rendered', () => {
  assert.equal(render('<div onclick="x()">hi</div>'), '')
})
