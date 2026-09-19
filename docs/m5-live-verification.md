# M5 bounded live routing verification

Date: 2026-09-18  
Status: complete

The frozen `pilot12-v1` plan ran once through `jev:production-v1`. It used 12 synthetic routing cases, one repeat, a maximum of 12 HTTP sends, a 5-second per-route deadline, a 90-second total deadline, model `jev-1.13.0`, prompt identity `production-v1`, and experimental confidence threshold `0`. The API key existed only in the parent process environment and is absent from the saved artifacts.

The finalized run ID is `0e56498e-09f0-4758-bf5f-d464cb290666`. All 12 planned cases were observed and accepted: tuning 6/6, author-exposed heldout 6/6, suitability 10/10, and readiness 2/2. There were no wrong selections, abstentions, operational errors, cancellations, or unexecuted rows. The ten suitability cases made exactly ten HTTP attempts. The two missing-context readiness cases were resolved locally with zero attempts.

Suitability latency had 10 observations, median 405.5 ms, and range 334–1,389 ms. The whole 12-case run had median 404.5 ms and range 0–1,389 ms because the two local readiness gates each took 0 ms. Provider-reported usage across the ten responses was 9,351 input tokens and 830 output tokens.

The saved rules control observed all 12 cases, accepted 6/12, and accepted readiness 2/2 and suitability 4/10. It made no HTTP request and has unavailable provider usage. The rules-versus-live comparison is compatible and complete across 12 paired rows with declared `variant` and `mode` axes. It reports an accepted-count delta of +6. Token deltas remain unavailable because rules usage is unavailable while live usage is provider-reported.

These are routing-label results on a small synthetic, author-exposed suite. Each suitability label accepts either Codex or Claude profile IDs with the matching role, so 12/12 does not establish a brand winner or worker competence. The threshold of `0` was frozen before the run to evaluate suitability without an uncalibrated cutoff. Provider-reported selected confidence ranged from 0.42 to 0.78, including values below 0.7; this run does not justify a production default threshold or a calibrated-accuracy claim. No worker, native Codex/Claude host flow, runtime permission boundary, task-quality verifier, or cost-savings benchmark ran.

The source suite raw SHA-256 remained `e7b9fd328ff362e278c21e9ea30112b2773f1e9632f09434f803d27f2851834f`. The saved run snapshot was semantically identical after canonical JSON normalization. JSON and JSONL parsing and a credential-pattern scan passed. The local historical artifacts contain validated observations and synthetic replay recordings, with no raw live provider request or response body. They are not part of the public release.

Future runs must use the bundled suite and config as inputs and write to a new external output directory. Historical evidence remains immutable.
