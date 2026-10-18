---
type: Fixed
pr: 5508
---
**Unpinned emitted-attribution checks prefer the upstream base** — Fork clones now try `upstream/next` before `origin/next`, preserve pin and CI precedence, and report the resolved base with the `GSD_EMITTED_BASE` override before failures or skips (#5187).
