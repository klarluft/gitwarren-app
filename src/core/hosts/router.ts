/**
 * Whether a request is answered here or somewhere else.
 *
 * M4.1 left a note saying this file was coming, and `isLocalOnly` in `ssh.ts`
 * has been standing in for it since: a backstop that refuses to forward
 * `hosts.*` and has no opinion about anything else, because until M4.3 nothing
 * was forwarded at all. This is the general decision, and it is one function.
 *
 * ## The host is on the envelope, not in the params
 *
 * `RpcRequest.host` carries an instance id. It is deliberately not a `hostId`
 * field on every input schema, and the difference is not cosmetic:
 *
 * - *Where* a request goes is not something the method means. `reviews.diff`
 *   has exactly one meaning, and it is the same meaning on every machine. A
 *   host field in its params would have to be threaded through the service, the
 *   MCP tool and the zod schema, none of which have any business knowing that
 *   more than one machine exists.
 * - It has to be *strippable*. The router removes it before forwarding, which
 *   is what makes a chain of hosts impossible to build by accident: what
 *   arrives at the far end is a request with no host on it, so the far end
 *   answers it itself. A hub cannot be talked into becoming a spoke.
 * - An older daemon ignores it. Unknown fields are ignored by every peer in
 *   this protocol (see `RPC_PROTOCOL_VERSION`), so a GUI that has learned about
 *   hosts can still talk to one that has not.
 *
 * ## Three ways a request stays here
 *
 * **No host.** The overwhelming majority. A link written before hosts existed,
 * or written today for a local review, is a request with no host on it, and it
 * behaves exactly as it did in M0.
 *
 * **Our own instance id.** `#/h/<this machine>/reviews/4` is a perfectly
 * ordinary thing to be handed - it is what a *different* GitWarren produces
 * when it links to this one, and rule 4 says a link resolves where it is
 * clicked. Answering it locally rather than looking for a `hosts` row pointing
 * at ourselves is the whole of that rule in one comparison.
 *
 * **`hosts.*`.** A host's list of hosts is its own business. Forwarding these
 * would make host A's list readable, and removable, from host B, and turn a hub
 * and its spokes into a mesh nobody asked for. Note that this is checked
 * *before* the host is resolved, so `hosts.list` with a host on it is answered
 * here rather than refused: the screen asking is the Hosts screen of this
 * install, and there is only one of those. The carrier still refuses to send
 * them, and that belt-and-braces is on purpose - a routing bug should not be
 * able to put one on a wire.
 *
 * ## What a host id resolves against
 *
 * The `hosts` table, by `instance_id` and never by target or label. An address
 * is a way to reach a machine and not the machine; the instance id is the one
 * name that survives a rename, a new IP and a different carrier, which is
 * exactly why routes carry it. A host that has been described but never met has
 * no instance id yet, so nothing can link to it - and that is the honest
 * answer, not a gap: until the machine has said who it is, this install cannot
 * tell it apart from any other.
 */
import { getInstanceId } from '../instance.js'
import { hostPool } from './pool.js'
import { requireInstance, routeFor } from '../services/hosts.js'
import { isLocalOnly } from './carrier.js'
import { dispatch } from '../rpc/dispatcher.js'
import { AppError } from '../../shared/errors.js'
import type {
  RpcMethod,
  RpcParams,
  RpcRequest,
  RpcResponse,
  RpcResult
} from '../../shared/rpc.js'

/** Answered by this install, whatever the request said. */
export function isAnsweredLocally(host: string | undefined, method: string): boolean {
  return host === undefined || host === getInstanceId() || isLocalOnly(method)
}

/**
 * Send a method wherever it belongs, and answer as if it had been local.
 *
 * A failure from a host arrives as the `AppError` it was raised as - a
 * `NOT_FOUND` from a daemon over `ssh` reaches a React component as the same
 * `NOT_FOUND` a local call would have thrown, which is what lets one set of
 * error handling serve both. The one code that is *added* out here is
 * `HOST_OFFLINE`, and it is added by the pool, which is the only layer that
 * knows the difference between "the answer is no" and "there was no answer".
 */
export async function route<M extends RpcMethod>(
  host: string | undefined,
  method: M,
  params?: RpcParams<M>
): Promise<RpcResult<M>> {
  if (isAnsweredLocally(host, method)) return dispatch(method, params)

  // `requireInstance` rather than a lookup here, because the editor launch in
  // `main/ipc.ts` resolves the same id for a different purpose and a link to a
  // machine that has since been forgotten should read the same either way.
  return hostPool.request(routeFor(requireInstance(host as string)), method, params)
}

/**
 * The door every carrier holding a message off a wire comes through.
 *
 * `handleRequest` in the dispatcher answers a request *here*; this one answers
 * it wherever it belongs. Carriers use this one, which is why the routing
 * decision is made once rather than in each of them - and why a browser tab
 * gets remote hosts for free: the tab reaches the core, and the core is the hub
 * whether or not it happens to have a window.
 *
 * Never throws, for the same reason `handleRequest` never does: a carrier
 * holding a byte stream has nowhere to put an exception.
 */
export async function handleRoutedRequest(request: RpcRequest): Promise<RpcResponse> {
  try {
    return { id: request.id, result: await route(request.host, request.method, request.params) }
  } catch (error) {
    return { id: request.id, error: AppError.from(error).toSerialized() }
  }
}
