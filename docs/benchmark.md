# Routing replay and evaluation

Jevbrain keeps routine verification offline. Replays call the production contracts and routing core with fixed inputs and recorded provider observations. They do not launch a worker or make a provider request.

## Run a routing replay

```bash
bun run bench routing-replay \
  --suite bench/routing-v1/suite.json \
  --out /tmp/jevbrain-routing-a

bun run bench routing-replay \
  --suite bench/routing-v1/suite.json \
  --out /tmp/jevbrain-routing-b

bun run bench routing-compare \
  --baseline /tmp/jevbrain-routing-a \
  --candidate /tmp/jevbrain-routing-b
```

Each run writes immutable JSON and JSONL artifacts plus a manifest and summary. Replay refuses to overwrite an existing output directory. Comparison validates the full case set, bindings, configuration identities, outcomes, and summaries before it reports a difference.

## What replay verifies

- request and response schema validation;
- task and delegation correlation;
- trusted registry and policy binding;
- availability, capability, and candidate-subset eligibility;
- selected-profile validation;
- missing context, no eligible target, abstention, cancellation, and transport failures;
- stable run publication and comparison behavior.

Recorded provider observations are synthetic inputs. Their usage and confidence fields are not live measurements.

## Routing evaluation suite

`routing-eval-v1` adds 12 synthetic delegations across implementation, investigation, review, and missing-context cases. The checked-in labels accept any registered profile with the matching role. They are regression labels, not unseen statistical validation.

Run the zero-request rules control and offline Jev replay:

```bash
bun run bench eval \
  --suite bench/eval/pilot-v1/suite.json \
  --config bench/eval/pilot-v1/rules.json \
  --out /tmp/jevbrain-eval-rules --json

bun run bench eval \
  --suite bench/eval/pilot-v1/suite.json \
  --config bench/eval/pilot-v1/jev-replay.json \
  --out /tmp/jevbrain-eval-replay --json

bun run bench eval-compare \
  --baseline /tmp/jevbrain-eval-rules \
  --candidate /tmp/jevbrain-eval-replay \
  --axes variant --json
```

The runner keeps the planned denominator when a deadline, cancellation, or request budget stops a run. Remaining cases become explicit `not_run` rows. It writes the manifest last, so a directory without a manifest is incomplete and cannot be compared.

## Controlled differences

Comparison requires changes to variant, policy, execution budget, implementation, model, prompt, or mode to be declared as axes. The report records both values. Implementation provenance includes the lockfile, runtime and SDK versions, contracts, router, runner, and adapter source digests.

Usage is numeric only when both runs contain the same observed usage kind. Missing usage remains unavailable and never becomes zero. Tokens from different providers are kept separate. Replay tokens are not compared with provider-reported live tokens as if they were the same measurement.

## Live mode

Live evaluation is separately enabled. It requires an explicit live config, `--live`, trusted policy opt-in, and a credential supplied through the process environment. Fixed request counts and deadlines bound the run. Never put credentials in configs, commands, fixtures, or artifacts.

The historical bounded pilot is documented in [M5 routing evaluation](m5-evaluation.md) and [M5 bounded live routing verification](m5-live-verification.md). It evaluated routing labels only. It did not launch workers or measure task completion, host integration, permission enforcement, cost, speed, or savings.

## Package verification

`bun run verify:package` packs the real tarball, installs it in a disposable consumer directory, and exercises installed help and version output, bundled offline replays, comparison, and the default-off MCP roundtrip. It does not install globally or contact a provider.

Use focused tests for changed routing behavior. Keep default tests offline, use small fixtures, and report live checks separately from replay results.
