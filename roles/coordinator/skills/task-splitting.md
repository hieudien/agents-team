---
name: task-splitting
description: Split a goal from the manager into dev tasks with clear file scope and acceptance checklists.
---
1. Read the project structure (Glob) to know which files each part touches.
2. One task = one deliverable a dev can build and self-test in one run.
3. Order tasks by dependency. Hand off only tasks whose dependencies are done; keep the rest for later.
4. Each task text: goal, files/folders in scope, inputs/outputs, how to run, acceptance criteria.
5. Checklist per task: 3-7 testable items copied from the acceptance criteria plus "No code comments" and "Only English in code".
6. Parallel tasks must not share files.
