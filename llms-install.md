# Installing GitWarren's MCP server

This file is for an AI agent setting GitWarren up on a user's machine, such as
Cline reading it from the MCP marketplace. A person can follow it too.

## What you are installing

GitWarren is a code review app that runs on the user's own machine. Its MCP
server lets you open a review of a change, read the user's comments on it,
reply in a thread, and resolve what you fixed. Every result that carries a
review or a comment carries a `guiUrl`, a link the user clicks to see it.
Nothing leaves the machine: reviews live in one SQLite file in the user's
application-data directory, and the diff is read live from the git worktree.

## Prerequisites

- Node.js 22.14 or newer, or Node 24. The server's SQLite module needs
  Node-API 10, which older Nodes lack; under an older Node the server refuses
  to start and says so.
- A git repository the user wants reviewed. The server tracks repositories by
  absolute path; you add them with the `add_repository` tool.

No account, no API key, no environment variables.

## Configuration

Register one stdio server. The command downloads the published package on
first use and caches it.

```json
{
  "mcpServers": {
    "gitwarren": {
      "command": "npx",
      "args": ["-y", "gitwarren@latest", "mcp", "--serve"]
    }
  }
}
```

`--serve` makes the server also serve the review page on `127.0.0.1:41427`
for as long as it runs, so the links it hands out open even on a machine with
nothing else of GitWarren installed. If the GitWarren desktop app or
`gitwarren serve` is already running, the server serves nothing and links open
there instead.

On Windows, some clients need `npx` spelled as `npx.cmd`, or wrapped as
`cmd /c npx ...`. Use whichever form the client documents for npx-based
servers.

## Verify

Call `agent_identity` with no arguments. It returns the name your comments
will be attributed under, for example `Claude Code (AI)` or `Cline (AI)`. Then
call `list_repositories`; an empty list is a correct answer on a fresh install.

## Tools

`list_repositories`, `get_repository`, `add_repository`, `update_repository`,
`remove_repository`, `list_reviews`, `get_review`, `create_review`,
`update_review`, `remove_review`, `agent_identity`, `list_review_comments`,
`add_review_comment`, `reply_to_review_comment`, `resolve_review_comment`,
`update_review_comment`, `delete_review_comment`.

There is no tool that returns a diff. Run `git diff` yourself against the
repository; what GitWarren holds is the discussion.

## Usage

Open a review of the current branch's changes and hand the user the link:

1. `git rev-parse --show-toplevel` for the repository root;
   `list_repositories`, then `add_repository` with that path if it is not
   tracked.
2. `git branch --show-current` for the branch. `create_review` with
   `baseRef` set to the trunk, usually `main`, and `headRef` set to the
   branch. Uncommitted changes on the branch are included. On the trunk
   itself, pass the trunk as both refs to review exactly the uncommitted work.
3. End your reply with the review's `guiUrl`.

Before the next task, `list_reviews` with status `open`, then
`list_review_comments`; reply to the user's threads with
`reply_to_review_comment` and resolve what you fixed with
`resolve_review_comment`.

More: https://github.com/klarluft/gitwarren-app#agent-access-mcp and
https://gitwarren.com.
