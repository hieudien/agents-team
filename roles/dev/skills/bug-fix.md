---
name: bug-fix
description: Playbook for fixing a bug: reproduce first, find the root cause, add a regression test, then fix.
---
1. Reproduce the bug and record exact steps and the actual result. If you cannot reproduce it, report need_info instead of guessing.
2. Find the first point where behavior goes wrong (read the code path; do not patch where the symptom shows).
3. Write a failing test or a scripted check that captures the bug when the project has a test setup.
4. Make the smallest change that fixes the root cause.
5. Run the reproduction, the new test and the existing tests; all must pass.
6. Evidence per item: the command or steps and what you saw before and after.
