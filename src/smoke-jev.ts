import { createJevAdvisor } from "./route/jev-advisor.ts";
import { createTaskRouter } from "./route/router.ts";

const apiKey = process.env.TYPESAFE_API_KEY;
if (process.env.JEVBRAIN_LIVE_SMOKE !== "1" || apiKey === undefined || apiKey.length === 0) {
  process.stdout.write(
    "skipped: set JEVBRAIN_LIVE_SMOKE=1 and TYPESAFE_API_KEY to run the synthetic live Jev smoke\n",
  );
} else {
  const advisor = createJevAdvisor({ apiKey });
  const router = createTaskRouter({
    apiKey,
    advisor,
    registry: {
      registryVersion: "1.0.0",
      profiles: [
        {
          profileId: "synthetic-coder",
          profileVersion: "1.0.0",
          role: "Synthetic implementation profile",
          description: "Test-only profile for an explicitly enabled live routing smoke.",
          runtime: "codex-cli",
          model: "synthetic-model",
          capabilities: ["typescript"],
          enabled: true,
          declaredAvailable: true,
        },
      ],
    },
    policy: {
      policyVersion: "1.0.0",
      allowedProfileIds: ["synthetic-coder"],
      providerEnabled: true,
      egressEnabled: true,
      confidenceThreshold: 0.7,
      deadlineMs: 5_000,
      maxRequestBytes: 16_384,
      maxResponseBytes: 16_384,
    },
  });
  const result = await router(
    {
      delegationId: "synthetic-live-smoke",
      taskId: "synthetic-live-smoke",
      contextStatus: "ready",
      briefing: {
        objective: "Choose the test profile for a synthetic TypeScript task.",
        acceptanceCriteria: ["Return a bounded routing result."],
        constraints: ["Do not execute a worker."],
        decisions: ["This contains no repository or user context."],
      },
      requiredCapabilities: ["typescript"],
    },
    new AbortController().signal,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "selected") process.exitCode = 1;
}
