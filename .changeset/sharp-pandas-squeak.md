---
type: Fixed
pr: 5234
---
**`STATE.md` milestones that need YAML quoting, and `Session Continuity` fields whose values wrap, now survive `state.*` writes** — a milestone containing a literal `"` gained a layer of quotes and backslashes in `state.json` on every write; `state record-session` rewrote only the first line of a wrapped field, orphaning the rest, and now leaves such a field whole and names it under `skipped`; a missing `Stopped at:` is inserted in the section's own spelling and template order instead of as a bold line above the others; and a frontmatter-only `stopped_at` it replaces is reported in `replacedRecord` (#4998).
