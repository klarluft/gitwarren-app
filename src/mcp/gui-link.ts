/**
 * Links from a tool result back into the app.
 *
 * An agent that has just written a review has nowhere to point the user. The
 * `guiUrl` on every review and comment payload is that pointer: an
 * `http://127.0.0.1:41427/...` address served by the GUI, whose page carries the
 * `gitwarren://` link that actually raises the window. `main/link-server.ts`
 * explains why the chain has those three hops rather than one.
 *
 * The http form is not incidental. Terminals linkify http and almost never
 * linkify a custom scheme, and a link the user cannot click is no better than
 * no link at all.
 *
 * ## Why it is never null any more
 *
 * Until M2 this read the port out of a runtime file the GUI wrote, and returned
 * null when no GUI was running - there was no port to name, because the port
 * was whatever the OS had handed that particular launch.
 *
 * The port is now fixed and the instance id is a file that exists whether or
 * not anything is running, so there is always a link to give. That is the
 * better answer, and not only because it is shorter. A `guiUrl` is a string
 * that outlives the call: it is pasted into a chat, left in a commit message,
 * read on Thursday. Deciding at *mint* time that the user has no app to open is
 * a guess about a moment that has not happened yet, and it was wrong in the
 * common case - the user closes the window, the agent works for twenty minutes,
 * the user opens it again. What a dead link costs is one refused connection in
 * a browser; what a null cost was an agent telling the user there was nothing
 * to click.
 *
 * The same reasoning is what makes the link work across machines in M4: it
 * names a port every install listens on and an instance id that says whose
 * review it is, so the machine that resolves it is the machine it was clicked
 * on.
 */
import type { CommentLocation } from '../core/services/comments.js'
import { readLiveDaemonRuntime } from '../core/daemon-runtime.js'
import { getInstanceId } from '../core/instance.js'
import { loopbackFragmentFor } from '../shared/deep-link.js'
import { linkServerOrigin } from '../shared/link-port.js'
import { hrefFor, type ReviewRoute } from '../shared/routes.js'

/**
 * The other sentence, appended only when this install is actually listening.
 *
 * Conditional rather than always present, and that is the same decision
 * `guiUrl` made in the opposite direction. A `guiUrl` is always there because
 * loopback depends on nothing and a dead link costs one refused connection; a
 * `webUrl` names a machine on a network, and one that is not being served is a
 * URL that will never work for anybody, not just "not right now".
 *
 * The distinction it has to teach an agent is *which machine the person is
 * at*, because that is the only thing that decides which link is useful and
 * the MCP server has no way to know it. So the text says what each one is for
 * rather than ranking them.
 */
export const WEB_URL_NOTE =
  '\n\nWhen this machine is reachable on the user\'s tailnet, results also carry `webUrl`. ' +
  'The two links are for two situations and neither replaces the other: `guiUrl` opens ' +
  'GitWarren on the machine the user is sitting at, which is the right one when that is this ' +
  'machine; `webUrl` opens the same review in a browser from any of their devices - a phone, a ' +
  'laptop across the room - because it names this machine on their tailnet. Offer `webUrl` when ' +
  'the user is not at this machine, and both when you do not know.'

/**
 * The sentence appended to every tool that returns one of these.
 *
 * Spelled out at length on purpose. An agent that is not told what a field is
 * for will keep it to itself, and a link nobody is shown is wasted.
 *
 * It now also has to say what a *failed* link means, because there is no null
 * left to say it. The failure is visible to the user rather than to the agent -
 * the agent cannot open the URL and must not try - so what this has to produce
 * is the right reaction to the user reporting it, not a check the agent runs.
 */
export const GUI_URL_NOTE =
  '\n\nEach result carries `guiUrl`, a link that opens this in GitWarren. Show it to the user - ' +
  'it exists to be clicked, and it is how they see this without going and finding it themselves. ' +
  'The link works whether or not GitWarren is running right now, so hand it over without ' +
  'checking anything. If the user says it will not open - the browser reports that the ' +
  'connection was refused - then GitWarren is not running on their machine, and starting it ' +
  'makes the same link work.'

/** With the link attached. Kept as a type so the tool payloads stay honest. */
export type WithGuiUrl<T> = T & { guiUrl: string; webUrl?: string }

/** The links for one place, however many of them there are. */
export interface ReviewLinks {
  guiUrl: string
  webUrl?: string
}

export interface GuiLinker {
  /** The review's conversation, which is where a review as a whole lives. */
  review(reviewId: number): ReviewLinks
  /**
   * A thread, at its line of the diff where it has one. A line comment links
   * into the files tab so the user lands on the code being discussed rather
   * than on a list of discussions.
   */
  comment(location: CommentLocation): ReviewLinks
}

/**
 * A linker for one tool call.
 *
 * Still built per call rather than once at module load, even though nothing it
 * reads can change any more: `getInstanceId()` is cached after the first call,
 * so the cost is a property lookup, and the shape leaves room for M6 to add
 * `webUrl` alongside - which *is* something that changes while this process
 * runs, since it depends on whether the host is currently listening.
 */
export function guiLinker(): GuiLinker {
  const instanceId = getInstanceId()
  // Read per linker, which is per tool call. The owner publishes it when the
  // user flips the switch, and it disappears when the owner quits - which is
  // correct rather than unfortunate: a `webUrl` for a machine that is not
  // serving anything is a link that cannot work, and the whole rule is that it
  // is added *when a host listens*. `guiUrl` is unaffected, because loopback
  // depends on nothing.
  const webRoot = readLiveDaemonRuntime()?.webRoot ?? null

  const link = (route: ReviewRoute): string =>
    // The route rides in the fragment, which the browser never sends. The
    // server is not told which review this is for and has no use for it.
    `${linkServerOrigin()}/#${loopbackFragmentFor(instanceId, route)}`

  /**
   * The same review, as a browser on the tailnet reaches it.
   *
   * A plain app route rather than the `h=` loopback fragment, and the
   * difference is the whole of what those two notations were separated for in
   * M2. A loopback URL's fragment is a *deep link waiting to be assembled* -
   * the page at that address hands it to a local GitWarren, which then decides
   * whose review it is. A tailnet URL is not waiting for anything: the server
   * answering it is the machine that owns the review, so the fragment is an
   * ordinary route into the app it is already serving, with no host segment
   * because there is no other machine in the story.
   */
  const webLink = (route: ReviewRoute): string | undefined =>
    webRoot === null ? undefined : `${webRoot}${hrefFor(route)}`

  const both = (route: ReviewRoute): { guiUrl: string; webUrl?: string } => {
    const web = webLink(route)
    return { guiUrl: link(route), ...(web === undefined ? {} : { webUrl: web }) }
  }

  const conversation = (reviewId: number): ReviewRoute => ({
    name: 'review',
    reviewId,
    tab: 'conversation'
  })

  return {
    review: (reviewId) => both(conversation(reviewId)),
    comment: ({ reviewId, filePath, side, line }) =>
      both(
        filePath === null || side === null || line === null
          ? conversation(reviewId)
          : { name: 'review', reviewId, tab: 'files', focus: { filePath, side, line } }
      )
  }
}
