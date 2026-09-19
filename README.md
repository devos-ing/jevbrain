# jevbrain

Jevbrain adds profile selection to an existing sub-agent workflow. Your main session decides when to delegate and sends a bounded task brief to `task_route`. Jevbrain removes ineligible profiles, asks Jev to select from the remaining registered profiles, validates the response, and returns a profile ID. The host then launches that profile through its own runtime and returns the result to the same main session.

```text
main session decides to delegate
  → task_route checks the trusted registry and policy
  → Jev selects an eligible profile or abstains
  → host launches the selected profile
  → result returns to the main session for verification
```

Jevbrain makes the routing decision explicit and replayable. It does not decide whether to delegate, execute workers, raise permissions, or replace the host's verification step.

## Quick start

Install [Bun](https://bun.sh/) 1.3.8 or newer, then install the locked dependencies:

```bash
bun install --frozen-lockfile
```

The server requires a host-owned registry and policy:

```bash
bun bin/jevbrain.mjs server \
  --registry examples/routing-registry.json \
  --policy examples/routing-policy.json
```

The checked-in registry is disabled and its placeholder profile is unavailable. Replace the profile IDs, runtime metadata, capabilities, and availability with values that your host controls. Provider access and egress remain off until the trusted policy enables them. Keep credentials in the server environment, never in the registry, policy, or MCP config.

Use the [Codex MCP example](examples/codex-mcp.toml) or [Claude Code MCP example](examples/claude-code-mcp.json) as a starting point. Both contain path placeholders and do not activate either host by themselves.

## Replay the router offline

Run the production routing core against recorded provider observations:

```bash
bun run bench routing-replay \
  --suite bench/routing-v1/suite.json \
  --out /tmp/jevbrain-routing-replay
```

The replay makes no provider request and launches no worker. It checks eligibility, request serialization, response validation, abstention, and immutable run output.

For a visual explanation, open the [12-second routing replay](demos/routing-replay/README.md). It uses curated illustrative data and clearly separates Jev's selection from host-owned execution.

## What the host must own

- Decide whether a task should be delegated.
- Build the approved brief and candidate profile set.
- Supply the trusted registry, policy, permissions, and runtime availability.
- Launch the returned profile through an existing runtime.
- Verify and integrate the result in the original main session.

Candidate IDs in a request can only narrow the trusted registry. They cannot add profiles, commands, tools, data access, or permissions. If context is missing, no profile is eligible, the provider is disabled, or Jev abstains, `task_route` returns an explicit non-selection result.

## Current limits

The released routing core selects profiles only. Native Codex or Claude host activation, general worker execution, runtime permission enforcement, follow-up reads, repository retrieval, and context compression are not part of the released router. Existing synthetic live checks validate the bounded Jev transport and routing labels; they do not establish worker quality, accuracy calibration, speed, or savings.

Read the [routing contract](docs/routing-first.md), [context handoff rules](docs/context-handoff.md), [offline benchmark guide](docs/benchmark.md), and [roadmap](PLAN.md) for details.

## Development

```bash
bun run typecheck
bun run lint
bun run test
```

The demo's visual rhythm is inspired by [Tamara Tran's JevDemo on X](https://x.com/tamarajtran/status/2100694549362553153) and the MIT-licensed [fast-jev-compaction demo on GitHub](https://github.com/tamaratran/fast-jev-compaction/tree/main/demo/JevDemo).
