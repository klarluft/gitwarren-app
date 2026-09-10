/**
 * The Homebrew formula, filled in from tarballs that exist.
 *
 *   node scripts/build-homebrew-formula.mjs
 *
 * Reads every `gitwarren-daemon-<version>-<target>.tar.gz` in
 * `out/daemon-tarball`, hashes it, and writes `out/daemon-tarball/gitwarren-cli.rb`
 * from the template in `packaging/homebrew`.
 *
 * ## Why the formula is generated here rather than in the tap
 *
 * A tap that computes its own checksums has to download the release to do it,
 * which means the formula is written by a second job, at a second time, against
 * assets it has to hope are final. The failure that produces is not a build
 * error - it is a formula that installs the wrong version's tarball, or one
 * whose `sha256` was taken before an asset was re-uploaded, and it surfaces on
 * a user's machine as `SHA256 mismatch` with nothing on either end to say why.
 *
 * Hashing the file that is about to be uploaded, in the run that uploads it,
 * removes the window entirely. The tap's job becomes copying one file, which is
 * a thing that cannot be subtly wrong.
 *
 * The four checksums are all filled in whether or not the current run built all
 * four, and a missing one is an error rather than a placeholder left in place:
 * `__SHA256_LINUX_ARM64__` in a published formula is a `SHA256 mismatch` on
 * somebody's Raspberry Pi and a bug report that takes a day to understand.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']

const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const tarballs = join(root, 'out', 'daemon-tarball')

const template = readFileSync(join(root, 'packaging', 'homebrew', 'gitwarren-cli.rb'), 'utf8')
let formula = template.replaceAll('__VERSION__', version)

for (const target of TARGETS) {
  const path = join(tarballs, `gitwarren-daemon-${version}-${target}.tar.gz`)
  if (!existsSync(path)) {
    console.error(
      `${path} is missing. Every target has to be built before the formula can name it:\n` +
        TARGETS.map((one) => `  node scripts/build-daemon-tarball.mjs ${one}`).join('\n')
    )
    process.exit(2)
  }

  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  formula = formula.replace(`__SHA256_${target.toUpperCase().replace('-', '_')}__`, sha256)
  console.log(`${target}  ${sha256}`)
}

// Belt and braces, and cheap: a template placeholder that survives this loop
// means the naming convention above and the one in the .rb file have drifted,
// and the formula would be published with a literal `__SHA256_…__` in it.
const leftover = formula.match(/__[A-Z0-9_]+__/)
if (leftover) {
  console.error(`the template still holds ${leftover[0]} - nothing filled it in`)
  process.exit(2)
}

const out = join(tarballs, 'gitwarren-cli.rb')
writeFileSync(out, formula, 'utf8')
console.log(`\n${out}`)
