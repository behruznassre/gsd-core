---
type: Fixed
pr: 5233
---
**`worktree.reap-orphans` now names leftover `.claude/worktrees/` directories that git no longer tracks** — a Claude Code worktree whose teardown did not finish is reported as an `unregistered_residue` entry instead of the sweep answering `reaped: 0` while it sits on disk. Nothing is deleted. The output also gains a `scan` field saying which locations were actually read (#4941).
