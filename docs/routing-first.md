# Profile routing contract

Jevbrain routes a task only after the main session has decided to delegate it. The host prepares an approved brief and a candidate profile set. `task_route` applies trusted eligibility rules, asks Jev to select an eligible profile, validates the response, and returns the decision. The host owns every step before and after selection.

```text
main session plans the work
  → host decides to delegate
  → host prepares an approved brief and candidate IDs
  → task_route removes ineligible profiles
  → Jev selects one eligible profile or abstains
  → task_route validates and returns the decision
  → host launches the registered profile
  → result returns to the same main session
  → host verifies and integrates the result
```

The released router stops at the validated selection. It does not intercept native sub-agent calls, launch a worker, grant permissions, or verify the worker result.

## Registered profiles

Jev selects a `profileId`, not an arbitrary command. A trusted registry defines each profile's runtime, model metadata, capabilities, availability, version, and data-sharing properties. The host maps the returned ID to an execution method that it already controls.

A request may narrow the registry with candidate profile IDs. It cannot create a profile or broaden its tools, filesystem access, network access, model, or permissions. The router rejects unknown candidate IDs before contacting Jev.

## Routing input

`TaskRouteInputSchema` validates:

- `taskId` and `delegationId` for correlation;
- context readiness;
- a host-approved objective, acceptance criteria, constraints, and decisions;
- required capabilities;
- an optional subset of candidate profile IDs.

The routing brief contains only the information needed to choose a profile. It is separate from the full worker context. See [Context handoff](context-handoff.md) for source manifests and grants.

## Eligibility before advice

The router computes eligibility from the trusted registry and policy before it calls Jev. A profile must be enabled, available, policy-allowed, inside the request's candidate subset, and capable of the task. Jev cannot override these checks.

The router returns an explicit result when routing cannot continue:

| Status | Meaning |
| --- | --- |
| `selected` | Jev returned an eligible registered profile and the router validated it. |
| `abstained` | Provider access was disabled or unavailable, Jev abstained, confidence was below policy, or the bounded provider call failed safely. |
| `needs_context` | The host marked the routing context as incomplete. |
| `no_eligible_target` | No legal profile remained or the request named an unknown profile. |
| `cancelled` | The caller cancelled the route. |

Every result binds the decision to the task, delegation, input, registry, and policy digests. The binding prevents a decision from being reused silently with different inputs or configuration.

## Provider boundary

Provider access and egress are default-off. Both must be enabled by trusted policy, and credentials must be supplied to the server process. A credential's presence does not grant permission to send task content.

Each route allows at most one Jev HTTP attempt. The adapter disables SDK retries, enforces request, response, and total-time bounds, and forwards caller cancellation. Provider confidence is reported as an observation; it is not treated as calibrated accuracy.

## Host integration checklist

Before launching a selected profile, the host must:

1. Confirm that the route binding still matches the current task, registry, and policy.
2. Resolve the profile ID through the trusted registry, never through provider-supplied command text.
3. Recheck runtime availability and the actual permission boundary.
4. Build the worker context from approved sources.
5. Launch the worker through the host's existing runtime.
6. Correlate the result with the original delegation and verify it in the main session.

MCP registration alone does not perform these steps. The Codex and Claude Code config files in `examples/` are connection templates, not proof of native host activation.

## Current evidence and limits

Offline replay exercises the production eligibility function, router, official SDK serialization, validation, cancellation, and comparison logic without a provider request. Two bounded synthetic requests verified the direct Jev transport and the MCP STDIO path. A later 12-case synthetic pilot checked routing labels. See [M2 synthetic live verification](m2-live-verification.md) and [M5 bounded live routing verification](m5-live-verification.md).

These checks did not launch workers or establish task quality, native host integration, permission enforcement, calibrated confidence, speed, or savings. General dispatch and result recovery remain deferred.
