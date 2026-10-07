---
type: Fixed
pr: 5234
---
**A `STATE.md` milestone value that YAML has to quote is now read as its decoded value** — one containing a literal `"` was copied into `state.json` with an extra layer of quotes and backslashes on every `state.*` write (#5246).
