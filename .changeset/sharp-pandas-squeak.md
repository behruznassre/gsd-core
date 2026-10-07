---
type: Fixed
pr: 5234
---
**A quoted `STATE.md` milestone no longer gains an escape layer per `state.*` write, and `state record-session` no longer orphans the rest of a wrapped session field** — a milestone containing a literal `"` was copied into `state.json` with one more layer of quotes and backslashes on every write. `record-session` rewrote only the first line of a field whose value wraps; it now leaves such a field whole and lists it under `skipped`. Missing session fields are inserted beside their siblings in the section's own plain or bold form, without rewriting the section, and a frontmatter-only `stopped_at` it replaces is reported in `replacedRecord` (#4998).
