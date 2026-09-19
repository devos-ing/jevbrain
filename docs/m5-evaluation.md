# M5 routing evaluation

Date: 2026-09-18  
Status: complete; offline, clean-package, and one bounded live pilot verified

M5 adds `routing-eval-v1`, a routing-decision evaluation that never launches a worker. Its frozen `pilot12-v1` suite contains 12 independent synthetic delegations: six tuning cases and six author-exposed heldout cases. Each split covers local edit, cross-file edit, debugging, review, exploration, and missing-context readiness. Because the heldout labels are checked into the repository, they are useful for repeatable regression rather than a claim of unseen statistical validation.

## Frozen inputs and labels

The suite fixes the request, split, theme, acceptable outcome kinds, acceptable profile-ID sets, and label rationale. The registry has paired Codex CLI and Claude Code profiles for implementation, investigation, and review. Both runtimes are acceptable for the matching role; brand is not the expected answer. Every profile has the same genuine `typescript` capability, so capability filtering does not reveal the label. Label rationale is verifier-only data and is never sent to Jev.

Missing-context cases require the exact `needs_context` outcome. Advisor abstention and confidence-threshold abstention are distinct acceptable outcome kinds. Provider-disabled, missing-credential, timeout, malformed-response, and transport outcomes are operational errors and cannot score as intentional abstention.

The production Jev configuration fixes model `jev-1.13.0`, prompt identity `production-v1`, and experimental confidence threshold `0`. The threshold prevents an arbitrary calibration cutoff from converting a suitable selection into a failure. Provider confidence remains uncalibrated and is reported without an accuracy claim. Runtime model or prompt overrides are rejected before an output directory is reserved.

## Variants and limits

`rules:first-eligible-v1` calls the production eligibility function and selects the first eligible profile in registry order. It does not read labels, make an HTTP request, emit confidence, or fabricate provider usage. It is a simple engineering control rather than a host-native baseline.

`jev:production-v1` calls the production router and official TypeSafe SDK. Replay uses the checked-in synthetic response attached to each eligible case. Live mode requires both the live config and explicit `--live`; the API key is read from the process environment and is never written to an artifact.

The frozen live plan has 12 cases, one repeat, at most 12 actual HTTP sends, a 5-second route deadline, and a 90-second total deadline. The runner is sequential. It reserves a new output directory before any call, appends every row immediately, and writes `manifest.json` last as the completion gate. Budget exhaustion, deadline, and caller cancellation produce explicit `not_run` rows for every remaining case. A hard crash can leave partial files without a manifest; such a directory is not comparable.

## Commands

Run the zero-request rules control and the offline Jev replay:

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

An authorized bounded live run uses the same suite with `jev-live.json`, `--live`, and `TYPESAFE_API_KEY` supplied only in the environment. Do not add the key to a config or command example.

Comparison requires exact suite, registry, case, split, label, verifier, row, and summary integrity. A changed variant, policy, execution budget, implementation, model, prompt, or mode must be declared through `--axes`; the report records both values. Implementation provenance includes the shipped source `bun.lock`, Bun and SDK versions, routing contracts, router, runner, and adapter sources. Prompt identity combines the declared prompt version with a conservative digest of the current adapter source; changing that proxy must declare both prompt and implementation axes. Model and prompt are supported comparison identities for future runs, although this release executes only the pinned production identities. Usage differences are numeric only when both runs have the same observed usage kind. Rules-versus-replay and replay-versus-live token deltas remain unavailable rather than treating missing or synthetic tokens as real zeroes.

Summaries retain planned denominators for total, tuning, heldout, suitability, and readiness groups. They report observed and accepted cases, wrong selections, advisor/confidence abstentions, operational errors, cancellation, not-run counts, and observed latency median/range. Provider usage is marked `unavailable`, `synthetic`, or `reported`. These results evaluate routing decisions only; they do not measure worker quality, task completion, host integration, permissions, or cost savings.

## Local package verification

`bun run verify:package` packs the real tarball, installs it into a disposable consumer directory with Bun, and exercises the installed help/version, legacy routing replay, both M5 offline variants and their comparison, plus an official MCP client initialize/list/call against the default-off server. It neither installs globally nor changes host configuration.

## Offline verification evidence

On 2026-09-18, the frozen install, strict typecheck, Biome lint over 71 files, and the full 58-test/179-assertion suite passed. Package verification installed version `0.0.1` from its tarball and passed the M2 replay, both M5 offline variants and their comparison, and the default-off MCP roundtrip. The 63-file pack dry run includes the source `bun.lock` used by manifest provenance, the evaluator source, and all pilot fixtures.

Fresh artifacts are stored outside the repository at `/tmp/jevbrain-m5-final3.jYA9gR`. The rules run observed all 12 cases, accepted 6, and reported unavailable provider usage. Two replay runs accepted all 12 cases, each with 10 synthetic provider observations; their comparison paired all 12 with no decision or verdict change. The declared rules-versus-replay comparison reports an accepted-count delta of 6 and leaves token deltas unavailable because the usage kinds differ. Existing M0, M1, and M2 saved runs still compare compatible and semantically equal.

One bounded M5 live run has now completed: 12/12 accepted with ten provider attempts and two local context gates. Its metrics and limitations are in [M5 bounded live routing verification](m5-live-verification.md). Native Codex or Claude host activation, worker execution, runtime permission enforcement, task quality, and savings remain outside this evaluation.
