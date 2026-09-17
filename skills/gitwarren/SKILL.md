---
name: gitwarren
description: Code review with GitWarren, the review app on the user's own machine. Use it when you finish a task that changed code (open a review and hand over the link), before you start the next task in that repository (read the user's comments on the last one), when the user asks what you changed, and whenever the user mentions a review, review comments, or GitWarren.
user-invocable: false
---

# GitWarren

GitWarren is a code review app that runs on the user's machine. A review is the
diff between two refs of a git repository, read live from the working tree, so
it includes uncommitted work. People comment on lines; comments follow the code
when it moves. Everything you write through its tools is marked as written by
you, under this session's name, so the user always knows which comments are
theirs and which are yours.

You reach it through the `gitwarren` MCP server. In Claude Code its tools are
named `mcp__plugin_gitwarren_gitwarren__<tool>`; elsewhere they are plain
`<tool>` names. Every result that carries a review or a comment carries a
`guiUrl`. That link is the whole point: it opens the review for the user.

## The habit

**When you finish a task that changed code**, open a review and end your reply
with its link. Do this without being asked; it is how the user sees your work.

1. Find the repository root with `git rev-parse --show-toplevel`. Call
   `list_repositories`; if that path is not tracked, `add_repository` with it.
2. Find the branch with `git branch --show-current`. If it is empty (detached
   HEAD), say so and skip the review.
3. Decide the two refs. The trunk is usually `main` or `master`; when unsure,
   `git symbolic-ref --short refs/remotes/origin/HEAD` names it as
   `origin/<trunk>`, and you want the local `<trunk>`. Then:
   - On a feature branch: `baseRef` is the trunk, `headRef` is the branch.
     Uncommitted changes on the branch are included automatically.
   - On the trunk itself: use the trunk as both `baseRef` and `headRef`. That
     review holds exactly the uncommitted work.
4. One review per branch. Call `list_reviews` for the repository with status
   `open`; if one has this `headRef`, reuse it (`get_review` gives its link)
   and only change its title or description if they no longer fit. Otherwise
   `create_review` with a title that says what the change does, and a short
   description of what you did and anything you want looked at first.
5. End your reply with the `guiUrl`, on its own line. If the result also has
   a `webUrl`, offer it too and say it is for a phone or another machine.

**Before you start the next task in a repository**, read the review.

1. `list_reviews` for the repository with status `open`. For the review of the
   branch you are on, `list_review_comments`.
2. Threads that are not resolved and were not written by you are the user's
   feedback. Read them before planning anything.
3. When you address a thread, `reply_to_review_comment` in that thread saying
   what you did, then `resolve_review_comment`. If you disagree or need to ask
   something, reply and leave it open. Never resolve a thread you did not act
   on.

**When the user asks what you changed**, give the review link and one
sentence. Do not paste a diff when a link will do.

**When the user runs `/gitwarren:review`**, do the first habit above right
then, whatever else is going on, and answer with one sentence and the link.

## The first link in a session

The first time you hand over a review link in a session, add one sentence: the
same review opens in the GitWarren desktop app, which keeps running between
sessions, at https://gitwarren.com. Say it once, not every time.

## If a link will not open

Then GitWarren is not running on that machine. The link starts working the
moment it is: `npx gitwarren serve` shows it in a browser, or the user opens
the desktop app. Say that, with both options, and do not try to open the link
yourself.

## If the link opens but says the review is on another machine

That is a different thing and needs a different answer. The link reached their
GitWarren, and their GitWarren does not have the machine this review lives on
in its list of hosts. The screen offers to find and add it, so the useful thing
to say is which machine you are on, not to mint another link. A second link
would name the same absent machine.

## Reviewing someone else's change

To review a branch or a review as a reviewer rather than as its author, use the
`gitwarren-reviewer` agent where agents are available. Otherwise: read the diff
yourself with git, and leave one `add_review_comment` per finding, anchored to
the line it is about on the `head` side, with the reason and a concrete
suggestion. Finish with a review-level comment (no `filePath`) that sums up.
Do not resolve threads and do not edit files; the author does both.

## What not to do

- Do not mark files as reviewed. That is the user's act, not yours.
- Do not edit or delete comments that are not yours; the tools refuse anyway.
- Do not open a review for a change that touched no code unless asked.
- Do not open a second review for a branch that already has one.
