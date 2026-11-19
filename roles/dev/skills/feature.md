---
name: feature
description: Playbook for building a feature in small verifiable units.
---
1. Read how similar things are already done in the project and reuse them.
2. Split the feature into units that each end in a checkable state (one endpoint, one component, one screen).
3. Build one unit, verify it for real (run it, open it), then the next.
4. Add or update automated tests for the logic when the project has a test setup.
5. Re-check every acceptance item at the end; list anything skipped.
