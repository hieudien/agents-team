---
name: workload-balancing
description: Choose the right agent for a task and decide when to propose a new agent.
---
- Candidates = agents whose role matches the work.
- Score = queued + (1 if working). Pick the lowest score; on a tie prefer the agent who already worked on related files.
- Bug fixes go back to the dev who wrote the code unless that dev has score >= 3.
- Propose a new agent of a role when all agents of that role have score >= threshold (default 2) and there are tasks that can run in parallel. One proposal per role until it is answered.
