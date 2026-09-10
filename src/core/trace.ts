/**
 * Counting round trips.
 *
 * `GITWARREN_TRACE_IPC=1` logs every call a shell makes into the app, with when
 * it started and how long it took. The offsets are the useful part: calls that
 * start together are one round trip over a network, and a call that starts
 * after another finished is a second one. That number per screen is what spike
 * S5 measured and what M1 set out to reduce - see docs/across-hosts.md.
 *
 * Two callers, deliberately. The dispatcher traces every method, so every
 * carrier is measurable the moment it exists. `main/ipc.ts` traces the handful
 * of shell channels that are not methods, because they cost the renderer a
 * round trip too, and a count that quietly left them out would flatter itself.
 *
 * The `[ipc]` prefix is what `scripts/spikes/s5-ipc-per-screen.mjs` greps for.
 */
export const TRACE_CALLS = process.env.GITWARREN_TRACE_IPC === '1'

export async function traced<T>(label: string, call: () => Promise<T> | T): Promise<T> {
  if (!TRACE_CALLS) return call()

  const startedAt = performance.now()
  try {
    return await call()
  } finally {
    const duration = performance.now() - startedAt
    console.error(`[ipc] ${label} at ${startedAt.toFixed(0)}ms took ${duration.toFixed(1)}ms`)
  }
}
