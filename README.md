# CLA signatures

This branch exists only to store CLA signatures, collected by
`.github/workflows/cla.yml` (contributor-assistant/github-action).

It is deliberately an orphan branch with no shared history with `main`, so that
signatures never appear in a source diff and never trigger CI. The action
commits to `signatures/version1/cla.json` here every time a contributor posts
the signature phrase on a pull request.

The action does not create this branch itself — it only writes into an existing
one, and fails the check with

    Branch cla-signatures not found.
    Make sure the branch where signatures are stored is NOT protected.

if it is missing or protected. So: leave it unprotected, and do not delete it.

Nothing here should ever be merged into `main`.
