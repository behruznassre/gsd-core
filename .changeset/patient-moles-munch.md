---
type: Fixed
pr: 5352
---
**The managed debug loop can no longer detach its debugger through a shell spawn (#5214)** — on a captured run the debug session manager skipped its `Agent(run_in_background=false)` call and ran `claude --agent gsd-debugger` through Bash in the background, so no result came back and the checkpoint never advanced. The Bash guard hook now denies that command and tells the model to use the Agent tool, and both manager prompts state the rule.
