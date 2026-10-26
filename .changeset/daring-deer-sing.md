---
type: Fixed
pr: 5732
---
Saving settings as global defaults in /gsd-settings now merges into ~/.gsd/defaults.json instead of replacing it, so model_overrides, effort, runtime, resolve_model_ids and other keys the settings flow does not manage survive the save.
