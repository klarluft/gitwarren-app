/**
 * What a screencast leaves out, drawn back into the page.
 *
 * `Page.startScreencast` records the page and nothing else - no pointer, no
 * cursor - so a click reads as a screen that changed for no reason. The first
 * cut of the DHH clip had exactly that problem: three clicks, none visible,
 * and a viewer with no idea why the diff had just grown. And a silent clip of
 * an unfamiliar product needs one line saying what the beat on screen *is*.
 *
 * Both are elements in the page rather than a compositing pass afterwards, so
 * they land in the same frames at the same scale, and a storyboard's timing is
 * the only clock. Nothing here is interactive: the whole layer ignores the
 * pointer, so the real `Input.dispatchMouseEvent` underneath it still hits the
 * button it was aimed at.
 *
 * `install` once after the page has loaded; the rest are the three things a
 * storyboard says: the pointer is here, it clicked, and this is what you are
 * looking at.
 */
import { wait } from './cdp.mjs'

/** How long the drawn pointer takes to cross to its next target. */
export const CURSOR_TRAVEL_MS = 380

/** How long a caption takes to swap: out, then in. */
export const CAPTION_SWAP_MS = 200

const CURSOR_SVG =
  '<svg width="26" height="30" viewBox="0 0 24 28" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M4 2 L4 22 L9.5 17 L13 25.5 L16.8 23.8 L13.2 15.5 L20 15.5 Z" ' +
  'fill="#000" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>'

export async function install(cdp) {
  await cdp.evaluate(`(() => {
    if (window.__gwClip) return 'ok'

    const root = document.createElement('div')
    root.id = 'gw-clip-overlay'
    root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;' +
      'font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'

    // The pointer. The hotspot is the arrow's tip, at (4,2) in the SVG.
    const cursor = document.createElement('div')
    cursor.style.cssText =
      'position:absolute;left:0;top:0;opacity:0;' +
      'transition:transform ${CURSOR_TRAVEL_MS}ms cubic-bezier(.2,.7,.2,1),opacity 160ms;' +
      'filter:drop-shadow(0 2px 3px rgba(0,0,0,.55))'
    cursor.innerHTML = ${JSON.stringify(CURSOR_SVG)}

    // The click. A ring that grows from the point and fades, the way a screen
    // recorder draws one.
    const ring = document.createElement('div')
    ring.style.cssText =
      'position:absolute;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;' +
      'border:2.5px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.4),inset 0 0 0 1px rgba(0,0,0,.4);' +
      'opacity:0;transform:scale(.3)'

    // The caption. A lower third, sized for a phone showing the clip at a
    // third of this width.
    const caption = document.createElement('div')
    caption.style.cssText =
      'position:absolute;left:50%;bottom:40px;transform:translate(-50%,10px);opacity:0;' +
      'max-width:86%;padding:14px 26px;border-radius:14px;box-sizing:border-box;' +
      'background:rgba(16,18,26,.94);border:1px solid rgba(255,255,255,.14);' +
      'box-shadow:0 12px 40px rgba(0,0,0,.5);color:#fff;font-size:32px;line-height:1.3;' +
      'font-weight:600;letter-spacing:-.01em;text-align:center;white-space:pre-line;' +
      'transition:opacity ${CAPTION_SWAP_MS}ms ease,transform ${CAPTION_SWAP_MS}ms ease'

    root.append(cursor, ring, caption)
    document.body.appendChild(root)

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    window.__gwClip = {
      cursor(x, y) {
        cursor.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px)'
        cursor.style.opacity = '1'
      },
      hideCursor() {
        cursor.style.opacity = '0'
      },
      click(x, y) {
        ring.style.left = x + 'px'
        ring.style.top = y + 'px'
        ring.animate(
          [
            { transform: 'scale(.3)', opacity: 0.95 },
            { transform: 'scale(1.5)', opacity: 0 }
          ],
          { duration: 460, easing: 'cubic-bezier(.2,.7,.3,1)' }
        )
      },
      async caption(text) {
        if (caption.textContent === text && caption.style.opacity === '1') return
        caption.style.opacity = '0'
        caption.style.transform = 'translate(-50%,10px)'
        await sleep(${CAPTION_SWAP_MS})
        if (text === null) return
        caption.textContent = text
        caption.style.opacity = '1'
        caption.style.transform = 'translate(-50%,0)'
        await sleep(${CAPTION_SWAP_MS})
      }
    }
    return 'ok'
  })()`)
}

/** Glide the drawn pointer to a point, and only then put the real one there. */
export async function cursorTo(cdp, x, y) {
  await cdp.evaluate(`window.__gwClip.cursor(${x}, ${y})`)
  await wait(CURSOR_TRAVEL_MS + 40)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
}

/** A click where the pointer is: the ring, then the real press. */
export async function clickAt(cdp, x, y) {
  await cdp.evaluate(`window.__gwClip.click(${x}, ${y})`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await wait(70)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
}

/** Take the pointer out of the picture, and move the real one off any button. */
export async function parkCursor(cdp, size) {
  await cdp.evaluate(`window.__gwClip.hideCursor()`)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: size.width - 8,
    y: size.height - 8
  })
}

/** Say what the beat is; `null` clears it. Resolves once the swap has finished. */
export async function caption(cdp, text) {
  await cdp.evaluate(`window.__gwClip.caption(${JSON.stringify(text)})`)
}
