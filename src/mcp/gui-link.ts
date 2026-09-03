/**
 * Links from a tool result back into the running app.
 *
 * An agent that has just written a review has nowhere to point the user. The
 * `guiUrl` on every review and comment payload is that pointer: an
 * `http://127.0.0.1:<port>/...` address served by the GUI, whose page carries
 * the `gitwarren://` link that actually raises the window. `main/link-server.ts`
 * explains why the chain has those three hops rather than one.
 *
 * The http form is not incidental. Terminals linkify http and almost never
 * linkify a custom scheme, and a link the user cannot click is no better than
 * no link at all.
 *
 * Null when the app is not running, and null is a real answer rather than an
 * omission: the tool descriptions say what it means, because an agent will act
 * on a documented null far more reliably than on a field that is simply absent.
 */
import type { CommentLocation } from '../core/services/comments.js'
import { readLiveGuiRuntime } from '../core/gui-runtime.js'
import { deepLinkPathFor } from '../shared/deep-link.js'
import type { ReviewRoute } from '../shared/routes.js'

/**
 * The sentence appended to every tool that returns one of these.
 *
 * Spelled out at length on purpose. An agent that is not told what a field is
 * for will keep it to itself, and a link nobody is shown is wasted.
 */
export const GUI_URL_NOTE =
  '\n\nEach result carries `guiUrl`, a link that opens this in the GitWarren app. Show it to ' +
  'the user - it exists to be clicked, and it is how they see this without going and finding ' +
  'it themselves. When `guiUrl` is null, GitWarren is not running: say so, and tell the user ' +
  'to open it.'

/** With the link attached. Kept as a type so the tool payloads stay honest. */
export type WithGuiUrl<T> = T & { guiUrl: string | null }

export interface GuiLinker {
  /** The review's conversation, which is where a review as a whole lives. */
  review(reviewId: number): string | null
  /**
   * A thread, at its line of the diff where it has one. A line comment links
   * into the files tab so the user lands on the code being discussed rather
   * than on a list of discussions.
   */
  comment(location: CommentLocation): string | null
}

/**
 * A linker for one tool call.
 *
 * The runtime file is read once here and reused for every item in the result,
 * and never cached beyond that. This process routinely outlives several GUI
 * launches - the user closes the app and opens it again while the agent is
 * still running - so a port remembered at startup would be wrong by lunchtime.
 */
export function guiLinker(): GuiLinker {
  const runtime = readLiveGuiRuntime()

  const link = (route: ReviewRoute): string | null =>
    // The route rides in the fragment, which the browser never sends. The
    // server is not told which review this is for and has no use for it.
    runtime ? `http://127.0.0.1:${runtime.port}/#${deepLinkPathFor(route)}` : null

  const conversation = (reviewId: number): string | null =>
    link({ name: 'review', reviewId, tab: 'conversation' })

  return {
    review: conversation,
    comment: ({ reviewId, filePath, side, line }) =>
      filePath === null || side === null || line === null
        ? conversation(reviewId)
        : link({ name: 'review', reviewId, tab: 'files', focus: { filePath, side, line } })
  }
}
