---
type: Fixed
pr: 5435
---
The UI-SPEC component inventory gate now always cross-checks the first enumeration command against a filesystem count, records a mismatch, and resolves the version from the lockfile when node_modules is absent, treating empty output, a non-zero exit or 'undefined' as a failed lookup.
