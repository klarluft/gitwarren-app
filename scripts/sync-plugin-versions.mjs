/**
 * One version, copied into every manifest that has to state it.
 *
 *   node scripts/sync-plugin-versions.mjs          # write
 *   node scripts/sync-plugin-versions.mjs --check  # fail if any differ (CI)
 *
 * The version of GitWarren lives in package.json and nowhere else: the build
 * stamps it into the bundles, electron-builder reads it, the npm package is
 * generated from it. The plugin manifests broke that rule the day they were
 * added, because each format insists on carrying its own `version` field and
 * none of them can point at package.json instead. Four files said 0.1.10 while
 * the package said 0.1.11 within the hour of the first release after them.
 *
 * So this runs from the `version` script in package.json, which npm invokes
 * after it has bumped the number and before it commits - and what the script
 * `git add`s goes into that same commit. `npm version patch` therefore keeps
 * producing one commit that says the version once, in every file that has to
 * say it, and nobody has to remember a second step. `--check` is the same
 * comparison as a CI gate, for the hand-edited case.
 *
 * The version strings are not what keeps a plugin current, and it is worth
 * saying so: the plugin's server is fetched by `npx` at latest, or is the
 * installed app's own, so the code a user runs is always the released one.
 * What the manifests' versions do is tell each tool that something changed -
 * Gemini CLI compares them to decide whether an extension has an update, and
 * the marketplaces show them - so a stale one reads as "nothing new" to a
 * tool and as carelessness to a person.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Every `ARG GITWARREN_VERSION=` line in the Dockerfile, one per build stage. */
const DOCKERFILE_PIN = /^ARG GITWARREN_VERSION=(.+)$/gm

/**
 * The pinned install in the Glama build spec. Only the pinned spellings, so
 * that the prose around it can go on saying `npx gitwarren mcp` untouched.
 */
const SPEC_PIN = /gitwarren@(\d+\.\d+\.\d+[^\s"`]*)/g

/**
 * Where the version has to appear, and how to reach it in each file. The
 * marketplace lists the plugin as an entry, so its field is one level down.
 */
const manifests = [
  { file: '.claude-plugin/plugin.json', get: (m) => m.version, set: (m) => (m.version = version) },
  {
    file: '.claude-plugin/marketplace.json',
    get: (m) => m.plugins[0].version,
    set: (m) => (m.plugins[0].version = version)
  },
  { file: 'plugin.json', get: (m) => m.version, set: (m) => (m.version = version) },
  { file: 'gemini-extension.json', get: (m) => m.version, set: (m) => (m.version = version) },
  // The MCP registry entry states the version twice: once for the server and
  // once for the npm package it points at, which must be the same package
  // version the release workflow has just published.
  {
    file: 'server.json',
    get: (m) => (m.version === m.packages[0].version ? m.version : `${m.version}/${m.packages[0].version}`),
    set: (m) => {
      m.version = version
      m.packages[0].version = version
    }
  },
  // Not JSON, and the only entry that is not a manifest: the image installs the
  // published package by name, so the pin in it is a version of GitWarren like
  // any other and goes stale the same way. `text` swaps the parse for the raw
  // string; the getter reports every distinct value it found, so that the two
  // build stages drifting apart is a failure rather than a coin toss.
  {
    file: 'Dockerfile',
    text: true,
    get: (s) => [...new Set([...s.matchAll(DOCKERFILE_PIN)].map((m) => m[1]))].join(' and '),
    set: (s) => s.replace(DOCKERFILE_PIN, `ARG GITWARREN_VERSION=${version}`)
  },
  // The Glama build spec names the version too. Glama's own field is on their
  // website and out of reach of anything here, so this cannot keep that in
  // step - what it keeps in step is the document somebody copies the field
  // from, which is the next best thing and the only part we own.
  {
    file: 'docs/glama-build-spec.md',
    text: true,
    get: (s) => [...new Set([...s.matchAll(SPEC_PIN)].map((m) => m[1]))].join(' and '),
    set: (s) => s.replace(SPEC_PIN, `gitwarren@${version}`)
  }
]

const check = process.argv.includes('--check')
const stale = []

for (const manifest of manifests) {
  const path = join(root, manifest.file)
  const raw = readFileSync(path, 'utf8')

  if (manifest.text) {
    const found = manifest.get(raw)
    if (found === version) continue
    stale.push(`${manifest.file} says ${found}`)
    if (check) continue
    writeFileSync(path, manifest.set(raw), 'utf8')
    continue
  }

  const parsed = JSON.parse(raw)
  if (manifest.get(parsed) === version) continue
  stale.push(`${manifest.file} says ${manifest.get(parsed)}`)
  if (check) continue
  manifest.set(parsed)
  // Two-space JSON with a trailing newline: the form this leaves behind, so
  // that from the second sync on a bump is a one-line diff per file. The first
  // sync also unfolded the arrays that had been written on one line by hand.
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
}

if (check && stale.length > 0) {
  console.error(`package.json says ${version}, but:\n  ${stale.join('\n  ')}`)
  console.error('Run `node scripts/sync-plugin-versions.mjs` and commit the result.')
  process.exit(1)
}

if (!check) {
  console.log(
    stale.length === 0
      ? `every manifest already says ${version}`
      : `set ${version} in ${stale.length} manifest(s)`
  )
}
