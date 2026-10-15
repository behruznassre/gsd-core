---
type: Fixed
pr: 5428
---
execute-phase now hands the regression gate's test-file list and the cumulative wave-failure count between steps through files instead of shell variables that did not survive across blocks, so the pytest regression gate runs only the collected prior-phase files and the Fix-now escalation can fire.
