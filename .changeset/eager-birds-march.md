---
type: Fixed
pr: 5434
---
gsd-tools no longer probes its own process start-time (a PowerShell launch on Windows, a `ps` on macOS) on every config read; capability-lock now probes once, on its first lock acquire (#5327).
