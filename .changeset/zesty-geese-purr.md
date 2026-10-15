---
type: Fixed
pr: 5432
---
gsd-doc-writer no longer invents a run step for projects that cannot be run locally: it falls back to the test command, then the build command, then states there is no standalone run mode, and it only cites a Makefile or package script as a quick start when the files that script needs exist.
