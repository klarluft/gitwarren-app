#!/usr/bin/env bash
#
# Build the throwaway repositories that scripts/seed-demo.ts points at.
#
# The seed writes reviews against three repositories and a discussion whose
# line comments are placed by finding text in the diff. That text has to exist
# somewhere on disk, in a branch that carries committed, staged, unstaged and
# untracked work at the same time - which is the whole thing the screenshots
# and the hero video are about. This script produces exactly that, from a
# pinned commit of this repository, so the demo can be rebuilt on any machine
# in a few seconds instead of being reconstructed by hand.
#
#   scripts/make-demo-repos.sh                 # into /tmp/gw-demo-repos
#   DEMO_REPO_ROOT=~/demo scripts/make-demo-repos.sh
#
# Then seed a database against it:
#
#   rm -rf /tmp/gw-demo
#   GITWARREN_DATA_DIR=/tmp/gw-demo DEMO_REPO_ROOT=/tmp/gw-demo-repos \
#     npx tsx scripts/seed-demo.ts
#
# The feature the demo branch pretends to add - a scoped shortcut registry with
# j/k/u bindings and a help overlay - is fiction. The real app grew a different
# design for the same idea later (src/renderer/src/lib/hotkeys.ts); the demo
# branch is based on the last commit before that landed, so the story it tells
# is at least plausible against the code it sits on.
set -euo pipefail

ROOT="${DEMO_REPO_ROOT:-/tmp/gw-demo-repos}"
SOURCE="${DEMO_SOURCE_REPO:-$(cd "$(dirname "$0")/.." && git rev-parse --path-format=absolute --git-common-dir)}"

# Merge of PR #8: the last main commit before keyboard shortcuts existed.
BASE=f41b379

# Two days ago, at a fixed time of day, so the commits tab reads as a
# conversation that happened over a couple of days rather than one that
# happened while the script ran.
DAY_AGO=$(( $(date +%s) - 24 * 60 * 60 ))
stamp() { date -r "$(( DAY_AGO - $1 * 60 * 60 ))" '+%Y-%m-%dT%H:%M:%S'; }
commit() {
  # $1 hours before "yesterday", $2 message
  local at
  at="$(stamp "$1")"
  GIT_AUTHOR_DATE="$at" GIT_COMMITTER_DATE="$at" git commit -q -m "$2"
}

rm -rf "$ROOT"
mkdir -p "$ROOT"

# ---- gitwarren-app: the repository the reviews are against -----------------

git clone -q --no-hardlinks "$SOURCE" "$ROOT/gitwarren-app"
cd "$ROOT/gitwarren-app"
git config user.name 'Michal Wrzosek'
git config user.email 'michal@wrzosek.pl'

git checkout -q -B main "$BASE"
# The clone's origin is a local path that will not exist on another machine,
# and a fetchable origin would let the app report "behind upstream" for main.
git remote remove origin

# ---- fix/untracked-file-crash -------------------------------------------------

git checkout -q -b fix/untracked-file-crash
node - src/core/diff-parser.ts <<'EOF'
const fs = require('node:fs')
const file = process.argv.at(-1)
fs.appendFileSync(
  file,
  '\n' +
    '/**\n' +
    ' * The hunk header for a file shown in full - an untracked file, or one git\n' +
    ' * could not diff - must describe the lines actually rendered, not the whole\n' +
    ' * file. A truncated file that claims all of its lines sends every anchor\n' +
    ' * past the end of the hunk.\n' +
    ' */\n' +
    'export function wholeFileHunkHeader(renderedLines: number): string {\n' +
    '  return `@@ -0,0 +1,${renderedLines} @@`\n' +
    '}\n'
)
EOF
git add -A
commit 60 'Describe only the rendered lines in a whole-file hunk header'

# ---- chore/pin-node-22 (closed in the seed) -------------------------------------

git checkout -q main
git checkout -q -b chore/pin-node-22
printf '22.12.0\n' > .nvmrc
git add -A
commit 200 'Raise the Node floor to 22.12'

# ---- feat/keyboard-shortcuts ----------------------------------------------
#
# Built last, and left checked out: its working tree is deliberately dirty,
# which is what the review finds, and what would block any later checkout.

git checkout -q main
git checkout -q -b feat/keyboard-shortcuts

# Commit 1: the registry.
mkdir -p src/renderer/src/lib
cat > src/renderer/src/lib/shortcuts.ts <<'EOF'
/**
 * Keyboard shortcuts, scoped to the screen that owns them.
 *
 * A screen registers the keys it understands while it is mounted and gives
 * them back when it unmounts, so `j` means "next file" on the diff and nothing
 * at all on the repository list. One listener on `window` does the dispatch;
 * React's own handlers run first and can still `stopPropagation` a key they
 * want for themselves.
 */
import { useEffect } from 'react'

export type ShortcutScope = 'files' | 'conversation' | 'commits'

export interface Shortcut {
  /** A single printable key: `j`, `u`, `?`. */
  key: string
  /** Shown in the help overlay. Omit to keep a binding out of it. */
  description?: string
  run: () => void
}

const registry = new Map<ShortcutScope, Shortcut[]>()

/** Keys pressed while typing belong to the text field, not to us. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (isTypingTarget(event.target)) return

  for (const shortcuts of registry.values()) {
    const match = shortcuts.find((shortcut) => shortcut.key === event.key)
    if (match) {
      event.preventDefault()
      match.run()
      return
    }
  }
}

let installed = false

export function useShortcuts(scope: ShortcutScope, shortcuts: Shortcut[]): void {
  useEffect(() => {
    registry.set(scope, shortcuts)
    if (!installed) {
      window.addEventListener('keydown', onKeyDown)
      installed = true
    }
    return () => {
      registry.delete(scope)
    }
  }, [scope, shortcuts])
}

/** Everything currently bound, for the help overlay. */
export function boundShortcuts(): ReadonlyMap<ShortcutScope, Shortcut[]> {
  return registry
}
EOF
git add -A
commit 26 'Add a scoped shortcut registry'

# Commit 2: bind it in the files tab.
FILES_TAB=src/renderer/src/features/reviews/review-files-tab.tsx
node - "$FILES_TAB" <<'EOF'
const fs = require('node:fs')
const file = process.argv.at(-1)
let source = fs.readFileSync(file, 'utf8')

const replace = (from, to) => {
  if (!source.includes(from)) throw new Error(`Anchor not found in ${file}: ${from}`)
  source = source.replace(from, to)
}

replace(
  "import { useStoredFlag, useStoredPreference } from '@/lib/preferences'\n",
  "import { useStoredFlag, useStoredPreference } from '@/lib/preferences'\n" +
    "import { useShortcuts } from '@/lib/shortcuts'\n"
)

replace(
  "  const [treeOpen, setTreeOpen] = useStoredFlag('files-tree', true)\n",
  "  const [treeOpen, setTreeOpen] = useStoredFlag('files-tree', true)\n" +
    '\n' +
    '  const stepFile = useCallback(\n' +
    '    (delta: number): void => {\n' +
    '      const cards = [...document.querySelectorAll<HTMLElement>(\'[data-file-card]\')]\n' +
    '      const current = cards.findIndex((card) => card.getBoundingClientRect().top >= 0)\n' +
    '      const next = cards[Math.max(0, Math.min(cards.length - 1, current + delta))]\n' +
    "      next?.scrollIntoView({ block: 'start', behavior: 'smooth' })\n" +
    '    },\n' +
    '    []\n' +
    '  )\n' +
    '\n' +
    "  useShortcuts('files', [\n" +
    "    { key: 'j', run: () => stepFile(1) },\n" +
    "    { key: 'k', run: () => stepFile(-1) },\n" +
    '    {\n' +
    "      key: 'u',\n" +
    '      run: () => setIncludeUncommitted((current) => !current)\n' +
    '    }\n' +
    '  ])\n'
)

fs.writeFileSync(file, source)
EOF
git add -A
commit 25 'Bind j, k and u on the files tab'

# Staged, not committed: descriptions for the help overlay.
node - "$FILES_TAB" <<'EOF'
const fs = require('node:fs')
const file = process.argv.at(-1)
let source = fs.readFileSync(file, 'utf8')
const replace = (from, to) => {
  if (!source.includes(from)) throw new Error(`Anchor not found in ${file}: ${from}`)
  source = source.replace(from, to)
}
replace("    { key: 'j', run: () => stepFile(1) },\n", "    { key: 'j', description: 'Next file', run: () => stepFile(1) },\n")
replace("    { key: 'k', run: () => stepFile(-1) },\n", "    { key: 'k', description: 'Previous file', run: () => stepFile(-1) },\n")
replace(
  "      key: 'u',\n      run:",
  "      key: 'u',\n      description: 'Include or exclude uncommitted changes',\n      run:"
)
fs.writeFileSync(file, source)
EOF
git add "$FILES_TAB"

# Unstaged: a guard against key auto-repeat in the registry.
node - src/renderer/src/lib/shortcuts.ts <<'EOF'
const fs = require('node:fs')
const file = process.argv.at(-1)
let source = fs.readFileSync(file, 'utf8')
const from = '  if (isTypingTarget(event.target)) return\n'
if (!source.includes(from)) throw new Error(`Anchor not found in ${file}`)
source = source.replace(
  from,
  from +
    '  // Holding `j` should not run down the whole file list in one go.\n' +
    '  if (event.repeat) return\n'
)
fs.writeFileSync(file, source)
EOF

# Untracked: the help overlay, which exists only on disk.
cat > src/renderer/src/features/reviews/shortcut-help.tsx <<'EOF'
/**
 * The `?` overlay: every shortcut the current screen understands.
 */
import { boundShortcuts, type ShortcutScope } from '@/lib/shortcuts'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'

const SCOPE_TITLES: Record<ShortcutScope, string> = {
  files: 'Files changed',
  conversation: 'Conversation',
  commits: 'Commits'
}

interface ShortcutHelpProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShortcutHelp({ open, onOpenChange }: ShortcutHelpProps) {
  const scopes = [...boundShortcuts().entries()]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        {scopes.map(([scope, shortcuts]) => (
          <section key={scope} className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">{SCOPE_TITLES[scope]}</h3>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5">
              {shortcuts
                .filter((shortcut) => shortcut.description)
                .map((shortcut) => (
                  <div key={shortcut.key} className="contents">
                    <dt>
                      <Kbd>{shortcut.key}</Kbd>
                    </dt>
                    <dd className="text-sm">{shortcut.description}</dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  )
}
EOF

# ---- two small repositories to fill the list ---------------------------------

filler() {
  local name="$1" title="$2" hours="$3"
  mkdir -p "$ROOT/$name"
  cd "$ROOT/$name"
  git init -q -b main
  git config user.name 'Michal Wrzosek'
  git config user.email 'michal@wrzosek.pl'
  printf '# %s\n' "$title" > README.md
  git add -A
  commit "$hours" 'Initial commit'
}

filler gitwarren-docs 'GitWarren documentation' 300
filler klarluft-website 'klarluft.com' 400

cd "$ROOT/gitwarren-app"
echo "Demo repositories in $ROOT"
git status --short --branch
