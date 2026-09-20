/**
 * Point the seeded tailnet host at the port it really serves.
 *
 * A capture moves `LINK_SERVER_PORT` off 41427 because the installed app holds
 * it, and `normaliseTarget` fills a bare hostname with that moved port - so a
 * host seeded as `pc-win.tail688c0c.ts.net` ends up addressed at :41428, where
 * nothing answers. Seeding with an explicit port avoids it; this fixes a
 * database that was seeded without one, while `serve` is running against it.
 *
 *   GITWARREN_DATA_DIR=<seeded dir> HOST_LABEL=pc-win \
 *     HOST_TARGET=pc-win.tail688c0c.ts.net:41427 npx tsx scripts/ad/set-host-target.ts
 */
import { hostsService } from '../../src/core/services/hosts.js'

const label = process.env.HOST_LABEL ?? 'pc-win'
const target = process.env.HOST_TARGET
if (!target) throw new Error('Set HOST_TARGET, port included.')

const host = hostsService.list().find((candidate) => candidate.label === label)
if (!host) throw new Error(`No host labelled ${label}; have ${hostsService.list().map((h) => h.label).join(', ')}`)

const updated = hostsService.update({ id: host.id, target })
console.log(`${updated.label}: ${host.target} -> ${updated.target}`)
