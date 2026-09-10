/**
 * Coverage for the two strings a browser tab and the server that answers it
 * both have to spell the same way.
 *
 * `webAttachmentSrc` is compiled into a browser bundle and `attachmentNameFrom
 * WebPath` runs in the process serving it, and between them sits an `<img>`
 * whose only symptom of disagreement is a picture that does not appear. That is
 * the same class of failure as the doubled `#` M3.1 shipped and had to find
 * afterwards - nothing throws, nothing is logged, and the page looks plausible.
 * So the pair is asserted as a round trip rather than one function at a time.
 *
 * The refusals are the other half. The name in the URL comes out of a comment
 * body, and comment bodies are written by agents that may have just read
 * untrusted content out of the repository under review.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachmentUrl } from '../attachments.js'
import { attachmentNameFromWebPath, webAttachmentSrc, WEB_PATHS } from '../web.js'

const SHA = 'a'.repeat(64)

test('a token becomes a path on this origin, and reads back as the same file', () => {
  const path = webAttachmentSrc(attachmentUrl(SHA, 'png'))

  assert.equal(path, `${WEB_PATHS.attachments}${SHA}.png`)
  assert.equal(attachmentNameFromWebPath(path), `${SHA}.png`)
})

test('every format the store can hold survives the round trip', () => {
  for (const ext of ['png', 'jpg', 'gif', 'webp']) {
    const name = attachmentNameFromWebPath(webAttachmentSrc(attachmentUrl(SHA, ext)))
    assert.equal(name, `${SHA}.${ext}`, ext)
  }
})

test('a URL that is not one of our tokens is handed back untouched', () => {
  // The caller still gets to decide what a foreign URL means - `markdown.tsx`
  // renders it as a visible link rather than fetching it.
  for (const url of [
    'https://example.com/cat.png',
    'data:image/png;base64,iVBORw0KGgo=',
    './screenshot.png',
    'gitwarren://attachment/../../etc/passwd',
    'gitwarren://other/aaa.png'
  ]) {
    assert.equal(webAttachmentSrc(url), url)
  }
})

test('a path under the prefix that is not a legitimate name is not a name', () => {
  for (const name of [
    '../../etc/passwd',
    `${SHA}.png/../../etc/passwd`,
    `${'A'.repeat(64)}.png`,
    `${'a'.repeat(63)}.png`,
    `${SHA}.toolongext`,
    SHA,
    ''
  ]) {
    assert.equal(attachmentNameFromWebPath(`${WEB_PATHS.attachments}${name}`), null, name)
  }
})

test('a path outside the prefix is not an attachment request at all', () => {
  assert.equal(attachmentNameFromWebPath(`/attachments/${SHA}.png`), null)
  assert.equal(attachmentNameFromWebPath(WEB_PATHS.appInfo), null)
})
