# Jevbrain roadmap

Updated: 2026-09-19

Jevbrain is releasing the routing core first. The main session decides to delegate, `task_route` selects a registered eligible profile, and the host owns execution and verification.

## Released foundation

| Area | Status | Delivered behavior |
| --- | --- | --- |
| Response contracts | Complete | Zod contracts correlate a route result with the original delegation and reject malformed or unknown profiles. |
| Context split | Complete | Host-supplied sources are filtered through a trusted policy into a verbatim manifest and declarative grant. |
| Profile routing | Complete | Eligibility checks, a default-off Jev adapter, cancellation, bounded requests, CLI access, `task_route`, and the read-only `task_route_options` catalog tool. |
| Offline evaluation | Complete | Versioned replay and comparison commands exercise the production routing core without worker or provider execution. |
| Bounded routing checks | Complete | Synthetic live checks exercised the Jev transport and a fixed routing-label suite. Their limits remain explicit. |

These milestones establish profile selection. They do not establish automatic worker execution, native host integration, task-quality gains, calibrated confidence, or cost savings.

## Release focus

1. Publish a small English quick start, trusted configuration examples, and the offline routing replay.
2. Keep provider access default-off and preserve explicit selection, abstention, cancellation, and missing-context outcomes.
3. Document the host boundary so integrations launch only registered profiles under host-owned permissions.
4. Gather integration feedback before expanding the runtime boundary.

## Deferred work

General host dispatch, result recovery, follow-up reads, and enforced runtime boundaries remain deferred. Context compression and repository retrieval also remain deferred and are not enabled by this release. Comparative model or A/B studies are historical research, not part of the public product workflow.

Future runtime work starts only after a host adapter can prove the complete handoff: delegate, route, launch, return, verify, and correlate the result with the originating main session. Any such work must preserve the existing routing contract and default-off provider policy.

## Documentation map

- Read [docs/routing-first.md](docs/routing-first.md) for the selection contract and host integration boundary.
- Read [docs/context-handoff.md](docs/context-handoff.md) when preparing approved briefs, source manifests, or grants.
- Read [docs/benchmark.md](docs/benchmark.md) when changing routing behavior or replay fixtures.
- Read [docs/m2-live-verification.md](docs/m2-live-verification.md) and [docs/m5-live-verification.md](docs/m5-live-verification.md) for bounded historical transport evidence and its limits.
