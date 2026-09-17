/**
 * The harness's carrier: a third one, beside Electron IPC and the WebSocket.
 *
 * `shared/rpc.ts` says a carrier is "a way to reach whoever answers, and one
 * function". This one reaches a function Playwright put on `window` for it,
 * which runs in the Node process driving the browser and calls the *real*
 * `dispatch` against a real database and a real git repository (see
 * `visual/capture.ts`). Nothing is stubbed on the way: the screen being
 * photographed is answering the same questions, through the same services, that
 * it would answer in the app.
 *
 * That is the whole reason the harness is built at this seam rather than by
 * mocking `window.gitwarren` wholesale. A mocked bridge photographs a screen
 * the app cannot produce, and it drifts silently the day a method is added. A
 * carrier cannot drift: it is one function, and it is typed by `Carrier`.
 *
 * It also means no server, no port and no token. `gitwarren serve --listen`
 * binds 41427 deliberately and forever (`shared/link-port.ts`), so a harness
 * that wanted a real server would have to fight whatever GitWarren the
 * developer already has running on their own machine.
 */
import { resultOf, type RpcMethod, type RpcOutcome, type RpcParams, type RpcResult } from '@shared/rpc'
import type { WebCarrier } from '@web/carrier'

/** What `page.exposeFunction` installs, before anything on the page runs. */
declare global {
  interface Window {
    __visualRequest(
      method: string,
      params: unknown,
      host: string | null
    ): Promise<RpcOutcome<unknown>>
  }
}

export function createHarnessCarrier(): WebCarrier {
  return {
    request: async <M extends RpcMethod>(
      method: M,
      params: RpcParams<M>,
      host?: string
    ): Promise<RpcResult<M>> => {
      // `exposeFunction` carries arguments as JSON, which has no `undefined`:
      // an absent host is sent as null and put back on the other side, so that
      // "this install" stays distinguishable from a host literally named
      // "undefined" - see the note on `host` in `Carrier`.
      const outcome = await window.__visualRequest(method, params ?? null, host ?? null)
      return resultOf(outcome) as RpcResult<M>
    },
    // A harness carrier has nothing to be disconnected from: the function on
    // the other side is in the process that opened the page. Saying so plainly
    // is what keeps the offline banner out of every screenshot.
    connected: () => true,
    onConnectionChange: () => () => {},
    // Events are a *hint to re-ask*, and a screenshot asks once. Nothing pushes
    // here, so the listener is registered and never called.
    onEvent: () => () => {}
  }
}
