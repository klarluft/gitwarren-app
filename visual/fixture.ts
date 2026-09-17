/**
 * The repository the screenshots are of.
 *
 * Built rather than borrowed, and that is the point. Photographing a developer's
 * own checkout makes every screenshot a picture of whatever they happened to
 * have open that afternoon: the file list is different on two machines, the
 * diff is different after lunch, and a change to how a path is drawn cannot be
 * told apart from a change to which paths there were. A fixture is the same
 * repository every time, on every machine, so the only thing that can differ
 * between two runs is the code being reviewed.
 *
 * What it is shaped for is the file lists, because that is what tends to need
 * looking at: paths deep enough to wrap a narrow column, names long enough to
 * be awkward, two files with the same basename in different folders, and enough
 * changed files to cross the threshold where Files changed grows a filter box.
 * There is also uncommitted work, so the head is a worktree and the banner that
 * says so is in shot.
 *
 * Everything here runs before the core is imported - the data directory has to
 * be set first - which is why the services arrive through dynamic imports.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface Fixture {
  repositoryId: number
  reviewId: number
  /** Everything this fixture made, to be removed when the run is over. */
  cleanup: () => void
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

function write(root: string, path: string, contents: string): void {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents)
}

/**
 * A plausible module, long enough to scroll and with a header comment, because
 * this project's files all have one and a screenshot of code with none of them
 * does not look like a screenshot of this project.
 */
function module(name: string, extra = ''): string {
  return `/**
 * ${name}, as the fixture imagines it.
 *
 * Long enough that the file view has something to scroll, and ordinary enough
 * that nothing in it draws the eye away from the thing being photographed.
 */
import { resolveAnchor } from '@shared/comment-anchors'

export interface ${name}Options {
  /** Which version of the file to read. */
  changes: 'all' | 'committed' | 'uncommitted'
  limit: number
}

export function ${name.charAt(0).toLowerCase() + name.slice(1)}(
  paths: string[],
  options: ${name}Options
): string[] {
  const seen = new Set<string>()
  for (const path of paths) {
    if (seen.size >= options.limit) break
    if (resolveAnchor(path) !== null) seen.add(path)
  }
  return [...seen].sort((left, right) => left.localeCompare(right))
}
${extra}`
}

/** Paths chosen to be awkward in a narrow column, on purpose. */
const TREE: [string, string][] = [
  ['README.md', '# fixture\n\nA repository that exists to be photographed.\n'],
  ['package.json', '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n'],
  ['src/shared/routes.ts', module('Routes')],
  ['src/shared/comment-anchors.ts', module('CommentAnchors')],
  ['src/core/git-search.ts', module('GitSearch')],
  ['src/core/services/reviews.ts', module('Reviews')],
  ['src/core/services/repositories.ts', module('Repositories')],
  // Two files with the same basename, three folders apart: the case a flat
  // filter list has to keep distinguishable.
  ['src/core/services/index.ts', module('ServicesIndex')],
  ['src/renderer/src/lib/index.ts', module('LibIndex')],
  ['src/renderer/src/lib/fuzzy.ts', module('Fuzzy')],
  ['src/renderer/src/features/reviews/repository-files-tree.tsx', module('RepositoryFilesTree')],
  ['src/renderer/src/features/reviews/changed-files-tree.tsx', module('ChangedFilesTree')],
  ['src/renderer/src/features/reviews/review-browse-tab.tsx', module('ReviewBrowseTab')],
  ['src/renderer/src/features/reviews/review-files-tab.tsx', module('ReviewFilesTab')],
  ['src/renderer/src/features/comments/comment-thread-card.tsx', module('CommentThreadCard')],
  ['src/renderer/src/features/hosts/unknown-host-card.tsx', module('UnknownHostCard')],
  ['docs/across-hosts.md', '# Across hosts\n\nSpikes, in the order they were run.\n'],
  ['.gitignore', 'node_modules/\nout/\n']
]

/** Files the branch touches. Eighteen, so Files changed shows its filter box. */
const CHANGED = TREE.filter(([path]) => path.startsWith('src/')).map(([path]) => path)

export async function buildFixture(): Promise<Fixture> {
  const work = mkdtempSync(join(tmpdir(), 'gitwarren-visual-work-'))
  const checkout = join(work, 'fixture-repository')
  mkdirSync(checkout, { recursive: true })

  git(checkout, 'init', '-b', 'main')
  git(checkout, 'config', 'user.email', 'fixture@example.com')
  git(checkout, 'config', 'user.name', 'Fixture')

  for (const [path, contents] of TREE) write(checkout, path, contents)
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'The repository as it stood')

  // The branch under review. Left checked out here, so the head *is* this
  // worktree and the uncommitted edit below is part of what the review shows.
  git(checkout, 'checkout', '-b', 'feature')
  for (const path of CHANGED) {
    write(checkout, path, `${module(basenameOf(path))}\n// Changed on this branch.\nexport const REVISED = true\n`)
  }
  write(checkout, 'src/renderer/src/features/reviews/file-search-panel.tsx', module('FileSearchPanel'))
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'Find a file, and find what is in it')

  // Never committed, so the head is read from disk and the working-tree banner
  // is in every screenshot of the diff.
  write(checkout, 'src/renderer/src/lib/fuzzy.ts', `${module('Fuzzy')}\n// Still being written.\n`)

  const { repositoriesService } = await import('../src/core/services/repositories.js')
  const { reviewsService } = await import('../src/core/services/reviews.js')

  const repository = await repositoriesService.add({ path: checkout })
  const review = await reviewsService.create({
    repositoryId: repository.id,
    baseRef: 'main',
    headRef: 'feature',
    title: 'Find a file, and find what is in it',
    description:
      'A fixture review. Everything on this screen came from a real git repository ' +
      'through the real services — see `visual/carrier.ts`.'
  })

  return {
    repositoryId: repository.id,
    reviewId: review.id,
    cleanup: () => rmSync(work, { recursive: true, force: true })
  }
}

/** `a/b/my-file.tsx` -> `MyFile`, for the generated module's own name. */
function basenameOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  return name
    .split(/[-.]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}
