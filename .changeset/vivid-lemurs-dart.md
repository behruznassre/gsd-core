---
type: Fixed
pr: 4611
---
config-get no longer double-encodes a structured --default: a JSON array/object literal now reaches non-raw output as the structure it denotes, and --raw emits JSON for an array/object value instead of String(value). /gsd-code-review no longer hard-stops on an unconfigured workflow.code_review_depth_overrides.
