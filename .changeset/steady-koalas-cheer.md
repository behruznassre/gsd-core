---
type: Fixed
pr: 5232
---
**Running `commit`, `config-set` or a `state` command from a subdirectory of a linked git worktree that has its own `.planning/` now reads and writes that worktree's planning files** — it used to resolve to the main checkout and commit there while reporting success. A linked worktree without its own `.planning/` still resolves to the main checkout (#4885).
