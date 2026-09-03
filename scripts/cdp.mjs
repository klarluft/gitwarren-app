/**
 * A minimal Chrome DevTools Protocol client, shared by the capture scripts.
 *
 * Node ships a global WebSocket, so this needs no dependencies: it is a JSON-RPC
 * request/response pairing plus a place to hang event handlers, which is all
 * the screenshot and video scripts ask of the protocol.
 *
 * Start the app with a debugging port first:
 *
 *   GITWARREN_DATA_DIR=/tmp/gw-demo ./node_modules/.bin/electron . --remote-debugging-port=9222
 */
export class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()

  static async attach(port) {
    const response = await fetch(`http://localhost:${port}/json/list`)
    const targets = await response.json()
    const page = targets.find((target) => target.type === 'page')
    if (!page) throw new Error('No page target. Is the app running with --remote-debugging-port?')

    const client = new Cdp()
    await client.#connect(page.webSocketDebuggerUrl)
    return client
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      this.#socket = new WebSocket(url)
      this.#socket.addEventListener('open', () => resolve())
      this.#socket.addEventListener('error', () => reject(new Error(`Cannot connect to ${url}`)))
      this.#socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)

        // Events carry a method and no id; responses carry an id and no method.
        if (message.method) {
          for (const listener of this.#listeners.get(message.method) ?? []) {
            listener(message.params)
          }
          return
        }

        const waiting = this.#pending.get(message.id)
        if (!waiting) return
        this.#pending.delete(message.id)
        if (message.error) waiting.reject(new Error(message.error.message))
        else waiting.resolve(message.result)
      })
    })
  }

  send(method, params = {}) {
    const id = this.#nextId++
    this.#socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }))
  }

  /** Subscribe to a protocol event such as `Page.screencastFrame`. */
  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? []
    listeners.push(listener)
    this.#listeners.set(method, listeners)
    return () => {
      this.#listeners.set(
        method,
        (this.#listeners.get(method) ?? []).filter((candidate) => candidate !== listener)
      )
    }
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed')
    }
    return result.result?.value
  }

  close() {
    this.#socket.close()
  }
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait for the screen to stop changing.
 *
 * Every screen fetches through SWR, so there is a skeleton phase and then a
 * content phase, and the second one arrives whenever git happens to answer.
 * Polling until the rendered text is the same twice in a row is a far better
 * signal than any fixed sleep - and the skeleton check stops it settling on a
 * frame of placeholders.
 */
export async function settle(cdp, { timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout
  let previous = null
  let stableSince = null

  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const skeletons = document.querySelectorAll('.animate-pulse').length
      return JSON.stringify({ skeletons, text: document.body.innerText.length })
    })()`)

    if (state === previous && state !== null) {
      if (stableSince === null) stableSince = Date.now()
      const { skeletons } = JSON.parse(state)
      // Stable for two consecutive polls and nothing still loading.
      if (skeletons === 0 && Date.now() - stableSince >= 400) return
    } else {
      stableSince = null
    }

    previous = state
    await wait(250)
  }

  console.warn('  (timed out waiting for the screen to settle; capturing anyway)')
}

/**
 * Overlay scrollbars are a pointing-device affordance, and in a still image or
 * a recording they read as a stray line down the edge of the product.
 */
export async function hideScrollbars(cdp) {
  await cdp.evaluate(`(() => {
    const style = document.createElement('style')
    style.textContent = '*::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}'
    document.head.appendChild(style)
    return 'ok'
  })()`)
}
