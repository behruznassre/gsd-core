---
type: Fixed
pr: 5233
---
`worktree.reap-orphans` now names leftover `.claude/worktrees/` directories that git no longer tracks — a Claude Code worktree whose teardown did not finish — as `unregistered_residue` entries instead of answering `reaped: 0` while they sit on disk. It does not delete them. The output also gains a `scan` field saying which locations were actually read (#4941).
