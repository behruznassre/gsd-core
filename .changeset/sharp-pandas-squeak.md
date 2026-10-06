---
type: Fixed
pr: 5234
---
A `STATE.md` milestone value that YAML has to quote — one containing a literal `"` — is now read as its decoded value, so `state.*` writes no longer copy it into `state.json` with an extra layer of quotes and backslashes (#4998).
