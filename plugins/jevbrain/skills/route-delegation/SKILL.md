---
name: route-delegation
description: Route an already-approved sub-agent delegation through Jevbrain, then launch the selected registered profile through the host's existing runtime. Use after the main session has decided to delegate and has a bounded task brief.
---

# Route a delegation with Jevbrain

Use Jevbrain only after the main session has decided to delegate a concrete subtask.

1. Call `task_route_options` to list profiles that trusted policy allows and the host has marked enabled and available. An empty list means the host must configure availability before routing.
2. Prepare the objective, acceptance criteria, constraints, fixed decisions, required capabilities, and optional candidate profile IDs. Include only content approved for routing.
3. Call `task_route` once with that brief. Candidate IDs can only narrow the trusted options.
4. For a `selected` result, resolve the returned `profileId` through the host-owned registry. Launch that registered profile with the existing host runtime and current task grant.
5. Return the worker result to the same main session for verification and integration.
6. For `abstained`, `needs_context`, `no_eligible_target`, `cancelled`, or `error`, keep the explicit outcome. The main session decides whether to supply missing context, change the candidate set, handle the task itself, or stop.

Jevbrain selects a profile. It does not decide to delegate, execute provider-supplied commands, grant permissions, launch workers, or verify their results.
