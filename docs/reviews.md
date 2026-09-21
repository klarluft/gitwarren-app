# Reviews

A review is two refs and a title. Everything else on the screen is computed from
git when you look at it.

```
  reviews table                    read live, never stored
  ┌──────────────────┐             ┌───────────────────────────────┐
  │ repository_id    │             │ merge base of the two refs    │
  │ base_ref  "main" │  ──────►    │ commits in base..head         │
  │ head_ref  "feat" │             │ diff from the merge base      │
  │ title            │             │ which worktree holds head     │
  │ description      │             │ that worktree's dirty state   │
  │ status           │             └───────────────────────────────┘
  └──────────────────┘
```

## Why the refs are stored and the commits are not

Pinning the resolved shas at creation time would be the obvious thing to do, and
it would defeat the feature. A review is meant to *follow* its branch: you open
one, keep working, and the review shows the work as it stands. That includes work
that is not committed at all, which no sha could ever refer to.

The cost is that a review can stop resolving — someone deletes the branch. That
is treated as a state to render, not an error: the review row survives, the tab
says which ref went missing, and you can repoint it.

## Merge-base, like a pull request

The *files changed* tab shows `base...head` — what head added since the two
diverged — rather than the literal difference between the endpoints. So commits
that landed on `main` after you branched do not show up as reversals in your
review. The *commits* tab lists the same range, `base..head`.

## A ref against itself

The two endpoints may be the same ref. That is not an empty review: the merge
base of a ref with itself is its own tip, so the diff is exactly what the
worktree holds that has not been committed — the review you want when you just
wrote the code and want a second pair of eyes before it becomes a commit. Such a
review has no commits by definition, is titled *Uncommitted work on `<ref>`* by
default, and is drawn with one endpoint rather than an arrow between two.

## Finding uncommitted work

This is the part that needs care, because **the repository row points at one
directory and the work under review is often in another**. A branch checked out
in a linked worktree has its uncommitted state there, not in the main checkout.

So every read starts with `git worktree list --porcelain`, which enumerates the
main checkout and every linked worktree from *any* of them — it does not matter
which one was added to GitWarren. The worktree whose branch matches the review's
head ref is the one whose `git status` and working-tree diff get read. If no
worktree has that branch checked out, the review quietly falls back to committed
work only and says so.

Given the head's worktree, the diff is `git diff <merge-base>` run **inside it**,
with no second endpoint — which compares the merge base against the working tree,
so committed, staged and unstaged changes all arrive in one patch.

The files-changed tab offers three views of that, and the difference between
them is only which commit the diff is taken against:

| View | Command | What you see |
| --- | --- | --- |
| Committed | `git diff <merge-base> <head>` | the branch as it would arrive if pushed |
| All | `git diff <merge-base>` in the worktree | that, plus everything uncommitted |
| Uncommitted | `git diff <head>` in the worktree | only the edit being made right now |

The third exists for the case where you are making a small change on top of a
long-lived branch and want to see just that change. It is the same view a review
of a ref against itself gives — the merge base of a ref with itself *is* its own
tip — reached without repointing the review's endpoints and back again. It needs
a worktree holding the head; without one it shows nothing rather than silently
widening back out to the whole branch.

Untracked files are handled separately: they are listed with
`git ls-files --others --exclude-standard` (so `.gitignore` still applies) and
rendered as whole-file additions. The tempting alternative — staging them into a
scratch index with `GIT_INDEX_FILE` — would write blobs into the user's object
database just to draw a screen, and this app only ever reads.

The switch at the top of the tab turns all of that off, leaving the committed
diff. It is view state, not part of the review: whether you want to read the
branch as it sits on disk or as it would arrive if pushed is a per-visit
question.

## Reading the diff

`git diff` output is parsed once, in `src/core/diff-parser.ts`, into files,
hunks and numbered lines. Two details that a naive line-splitter gets wrong and
this one does not: paths are taken from the `---`/`+++` and `rename from`/`to`
lines rather than the ambiguous `diff --git a/x b/x` line, and a pure rename
carries no hunks at all yet still has to name both paths. Very large files are
clipped for rendering but still report their true add/delete counts.

## Navigating a large diff

Files changed carries three things a long diff needs, all of them optional and
none of them costing anything until used:

- **A file tree** down the left, folded so a lone directory collapses into its
  parent (`renderer/src` on one row). Clicking a file scrolls to it, and the row
  for whatever is nearest the top of the page stays highlighted as you scroll.
  The toggle beside it is remembered across restarts.
- **Unfolding the lines between the hunks**, the way GitHub does. `git diff`
  prints three lines of context, so most of a file is not on screen; the
  expanders in the gutter reveal twenty lines at a time or the whole run, and
  **Expand all lines** in the file header opens every gap at once. Unfolded
  lines are ordinary context rows — a comment can be left on one exactly as on
  any other line.

A `@@` header announces a break in the file, so it is drawn only while there is
still a break to announce. A folded gap carries the header on its own expander
row, the way GitHub puts the unfold controls there; unfold that gap and the
header goes with it, because the code now runs continuously into the hunk and a
divider across continuous code is a false statement about the file. Expand
everything and the file reads top to bottom with no markers in it at all.

The same rule removes the header from the top of a hunk that starts at line 1,
which is every new file and every deleted one: there is nothing above it to be
separated from. What keeps a header is a real break with no expander to mark it
— which happens in the files the diff cannot unfold at all (binary, clipped),
where it is the only thing saying two lines are not adjacent.
`continuesFromAbove` in `shared/diff-gaps.ts` decides this, using the same
off-by-one convention for empty ranges as the gap arithmetic beside it.
- **Copy path** and **open in your editor**, per file.
- **Back to top**, once you are a screen or so down. It is app-wide rather than
  a diff feature, but the diff is where the scrollbar gets small enough to
  matter. Two details: the whole app scrolls inside `<main>` rather than the
  window, so the button acts on that element (`window.scrollTo` would do
  nothing at all here); and the trip is animated only when it is short enough
  to follow — smooth-scrolling the length of a large diff takes seconds and
  reads as the app hanging, so past five thousand pixels it simply jumps.

Every icon-only control carries a real tooltip rather than a `title` attribute
(`components/ui/tooltip.tsx`). The browser decides when to show a `title` —
usually a second or more after the pointer stops — it cannot be styled, and it
never appears for keyboard users at all; a button whose whole meaning is its
label cannot afford any of that. One `TooltipProvider` at the root groups them,
so the first tooltip waits and moving along a row of buttons then shows each
immediately. `title` is still used for *supplementary* text: the full path
behind a truncated one, the meaning of a badge.

The unfolding costs one read of the whole file, taken the first time the
reviewer asks and reused for every later expansion of the same file. It is
deliberately not a line-range API: a range per click would be a git process per
click, and reading the file once is also the only way to know where it *ends*,
which no hunk header can say. The read follows whichever view of the changes is
on screen, because context taken from another version of the file would not line
up with the hunks it sits between. `src/shared/diff-gaps.ts` holds the arithmetic that
decides where the hidden runs are and which line number each unfolded line gets;
it is pure, and unit-tested against the shapes that get this wrong — a diff that
does not start at line 1, and git's off-by-one convention for an empty range.

## Marking a file reviewed

Each file header carries a **Reviewed** checkbox, and `v` ticks off whichever
file you are on. A ticked file folds away, the file tree marks it and dims it,
and the header counts how many of them are done — so a long diff shrinks to what
is still unread as you work through it.

The mark has to stop being true when the file changes, or the list would claim
someone had read code that did not exist when they looked at it. So what is
stored is not a flag but a digest of the diff that was on screen at the time
(`shared/diff-digest.ts`, a cyrb53 fingerprint of the path, the change status
and every line of every hunk). A mark counts only while the file still hashes to
the same value; when it does not, the tick clears itself and the file is
labelled **Changed since reviewed** — which is more useful than silently
unticking it, because it points at the one file that moved after being read.

Two consequences fall out of that rather than needing code of their own. Flipping
*include uncommitted* is a different diff, so a file read in one setting is not
ticked in the other. And reverting a change restores the mark, because the file
hashes the same way it did before.

The comparison runs in the renderer, against the diff being rendered, and the
main process only stores digests: the "include uncommitted" switch means one
review has two diffs at once, and a mark resolved against the one you are not
looking at would be answering a question nobody asked. The rows live in
`reviewed_files`, keyed by review and path, and go with the review when it is
deleted. There is no MCP tool for them — an agent claiming a human has read a
file would make the only honest signal on the screen worthless.

## Opening a file in an editor

`system.editors()` probes for VS Code, Cursor, Windsurf, Zed, Sublime Text and
the JetBrains launcher, once per run: the application bundle in the usual
locations, and the command on `PATH`. Whatever is found is offered in a picker
next to the diff, and the choice is kept in `localStorage` — a preference of the
person, not a fact about the review, and this app has no settings screen to put
it on.

Opening prefers the URL scheme the application registered for itself
(`vscode://file/…:12`), which carries the line number and works whether or not
the user ever installed the shell command; the CLI is the fallback, and the
platform's default handler for the file is the fallback to that.

Set `GITWARREN_EDITOR` to override, either with an id from the list above or
with a command template:

```sh
GITWARREN_EDITOR='emacsclient +{line} {file}'
```

The file is resolved inside the worktree that holds the head branch, not
necessarily the directory the repository was added from — the same rule the rest
of the app follows. A file that exists only in a commit has nothing to open, and
says so.
