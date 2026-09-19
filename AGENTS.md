# Project instructions

## Product boundary

The main session decides to delegate a subtask, calls `task_route`, and uses Jev's selection to launch an eligible sub-agent through its existing runtime. Results return to the same main session for verification and integration. Jev selects the sub-agent profile; the host owns planning, permissions, and execution. Initial integrations target Codex CLI and Claude Code.

- For routing contracts, profile selection, or host integration, read [docs/routing-first.md](docs/routing-first.md).
- For approved briefs, source manifests, grants, or access boundaries, read [docs/context-handoff.md](docs/context-handoff.md). Preserve required evidence and distinguish packet contents from runtime permissions.
- For routing behavior, replay fixtures, or evaluation changes, read [docs/benchmark.md](docs/benchmark.md). Reuse production contracts and core logic.
- For current scope and deferred work, read [PLAN.md](PLAN.md). Context compression and repository retrieval remain deferred unless the user explicitly resumes them.

## Stack and types

- Use Bun for the runtime, dependency management, scripts, and tests. Keep `bun.lock` as the project lockfile.
- Use TypeScript with strict checking and a separate `tsc --noEmit` check; running TypeScript with Bun does not replace type checking.
- Never introduce explicit or implicit `any` in project code or tests, including `as any`, `z.any()`, or generics containing `any`. Do not bypass this rule with casts or diagnostic suppressions.
- Treat external input, parsed JSON, environment configuration, and provider/CLI responses as `unknown` until validated with Zod.
- Define data contracts as Zod schemas and derive their types with `z.infer<typeof Schema>`. Use `z.input` or `z.output` when transformations make the distinction necessary. Keep one schema source of truth instead of parallel handwritten DTO types.
- Use discriminated unions for outcomes such as selection, abstention, and failure. Ordinary local values and function signatures can use normal TypeScript inference; they do not need artificial runtime schemas.

## CLI packages and output

- Use `commander` for CLI arguments/help and `picocolors` for terminal styling. Add `cli-table3` when a real tabular display is needed. Introduce packages when their feature is implemented, rather than building custom parsers, ANSI helpers, or table renderers.
- Use Biome for source formatting and linting. During bootstrap, make the no-explicit-any rule an error and retain strict compiler checking.
- Keep human-readable output separate from machine output. MCP STDIO stdout contains protocol messages only; diagnostics go to stderr. JSON output contains no colors, banners, prompts, or progress indicators.
- Human-facing CLI output respects `NO_COLOR` and non-interactive terminals. Routine diagnostics contain identifiers and timings, not API keys, full task context, or provider response bodies.

## Focused verification

- Check one representative core flow and, for behavior changes, its most relevant failure or permission boundary. Reuse focused `bun test` cases with real core logic and mocked provider/process boundaries. Add regression tests for observed bugs; coverage percentages, cosmetic snapshots, and library behavior are not targets.
- Run applicable type/lint/build checks once on the final changes. For UI edits, inspect the changed interaction at one viewport; add another only for responsive changes. Documentation-only edits need a diff/link review.
- Reuse the implementer's passing evidence for unchanged code. Repeat only affected checks after a failure or new edit. Stop verification when the relevant checks pass.
- Request an independent oracle review only when the user asks for it for this change or a specific unresolved correctness risk needs it. Routine delivery does not require a second agent review.
- Keep default checks offline. Live Jev/CLI evaluations remain separately enabled; report unverified work honestly. Frozen benchmark protocols retain their original checks; define reduced checks in a new protocol version before another measured run.

## Working conventions

- Keep the routing core separate from MCP and CLI adapters. Add files and abstractions when the current feature needs them.
- When simplifying a design, remove one element at a time and keep the removal only when required behavior and quality remain intact.
- Prefer indexed CodeGraph for symbols, callers, dependencies, and impact; use `rg` for literal text. Reuse adequate results and fall back to source search when the index is unavailable or stale.
- Complete the requested slice through focused verification and fixes. Report what changed, the checks actually run, and remaining limits; a mocked integration is not evidence of live routing quality.

When maintaining these instructions, follow [OpenAI's guidance on skills and prompts](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra): retain project-specific constraints, use conditional document pointers, and remove stale or duplicated procedures.
