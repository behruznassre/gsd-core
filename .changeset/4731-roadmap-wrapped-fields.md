---
type: Fixed
pr: 4803
---
A hard-wrapped `**Goal:**` or `**Requirements**:` in ROADMAP.md is no longer truncated at the first newline. Every reader of these fields captured only the label's own line, so a wrapped Requirements list silently dropped the IDs below it: `query init.plan-phase` returned a short `phase_req_ids`, plan-phase's coverage gate could not report the missing IDs as uncovered because it never saw them, `roadmap.get-phase` returned a goal cut off mid-sentence, and `phase complete` marked the visible IDs Complete, left the rest Pending, and reported no warnings. The five duplicated single-line readers are consolidated into one continuation-aware extractor that folds a value through to the next blank line or `**Field**` heading, matching how Success Criteria already handled wrapping.
