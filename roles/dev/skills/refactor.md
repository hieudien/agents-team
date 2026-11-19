---
name: refactor
description: Playbook for refactoring without changing behavior: record behavior first, change structure, compare.
---
1. Record current behavior before touching code: run existing tests, or write a quick script or capture the page output.
2. Change structure in small steps; run the checks after each step.
3. Do not mix behavior changes into the refactor; note them for a separate task.
4. Finish by re-running the recorded checks and confirming the output is identical.
5. List files touched and what was deleted; prefer deleting code over adding.
