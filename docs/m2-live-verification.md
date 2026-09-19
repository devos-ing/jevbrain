# M2 synthetic live verification

Date: 2026-09-18  
Scope: two explicitly authorized Jev requests using synthetic routing inputs only

This check validates the production TypeSafe SDK transport and the MCP STDIO path against `jev-1.13.0`. It did not launch a worker, activate Jevbrain in Codex or Claude Code, read repository context, or evaluate task quality.

| Path | Result | Attempts | Elapsed | Provider-reported confidence | Provider-reported usage |
| --- | --- | ---: | ---: | ---: | ---: |
| `smoke:jev`, one synthetic coder profile | selected `synthetic-coder` | 1 | 792 ms | 0.77 | 514 input / 38 output tokens |
| Official MCP client → package launcher STDIO server, two synthetic profiles | selected `synthetic-claude-reviewer` for a read-only review brief | 1 | 853 ms | 1.00 | 643 input / 47 output tokens |

The MCP run initialized the server, listed exactly `task_route`, called it once, validated task/delegation/registry/policy binding, and returned JSON only in text content without duplicate `structuredContent`. Both runs exited successfully with no stderr. Together they made two HTTP attempts and reported 1,157 input and 85 output tokens.

The confidence and token values above are provider-reported observations from these two requests. They are not calibrated accuracy, routing-quality, cost, or comparative benchmark evidence. The selected runtime/model fields describe synthetic registered profiles; no Codex CLI or Claude Code worker was launched and their availability or permissions were not verified.

The sanitized run artifacts were checked for API keys and raw provider errors during verification. Historical artifacts are retained locally and are not part of the public release.

The checked-in examples remain disabled and unavailable by default. Live routing still requires an explicit trusted policy opt-in and a key supplied to the process environment.
