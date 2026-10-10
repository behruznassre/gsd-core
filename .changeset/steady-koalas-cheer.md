---
type: Fixed
pr: 5232
---
**Running `commit`, `config-set` or a `state` command from a subdirectory of a linked git worktree that has its own `.planning/` now reads and writes that worktree's planning files** — it used to resolve to the main checkout and commit there while reporting success. A linked worktree without its own `.planning/` still resolves to the main checkout. The Claude and Cursor subagent isolation guards now resolve a dispatch from a project subdirectory, at any depth, to its project and read the isolation decision where `gsd-tools` recorded it, so the executor is checked instead of being let through as "not a GSD project"; when a directory is inside a project but the guard cannot resolve which root governs it (the runtime library will not build, or git times out), the dispatch is blocked (#4885).
