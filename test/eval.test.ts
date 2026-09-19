import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readJson, readJsonLines } from "../src/benchmark/io.ts";
import { compareEvaluations } from "../src/eval/compare.ts";
import {
  EvalManifestSchema,
  EvalRowSchema,
  EvalRunConfigSchema,
  EvalSuiteSchema,
  EvalSummarySchema,
} from "../src/eval/contracts.ts";
import { routeByFirstEligible } from "../src/eval/rules.ts";
import { runEvaluation } from "../src/eval/run.ts";
import { evaluateObservation, isAdmissibleSelection } from "../src/eval/verify.ts";

const fixtureRoot = resolve(import.meta.dir, "../bench/eval/pilot-v1");
const suiteFile = join(fixtureRoot, "suite.json");
const rulesConfigFile = join(fixtureRoot, "rules.json");
const replayConfigFile = join(fixtureRoot, "jev-replay.json");

test("pilot labels accept either eligible runtime for the same approved role", async () => {
  const suite = EvalSuiteSchema.parse(await readJson(suiteFile));
  expect(suite.cases).toHaveLength(12);
  expect(suite.cases.filter(({ split }) => split === "tuning")).toHaveLength(6);
  expect(suite.cases.filter(({ split }) => split === "heldout")).toHaveLength(6);
  const benchmarkCase = suite.cases[0];
  if (benchmarkCase === undefined) throw new Error("pilot case missing");
  for (const profileId of benchmarkCase.labels.acceptableProfileIds) {
    const reordered = {
      ...suite.registry,
      profiles: [
        ...suite.registry.profiles.filter((profile) => profile.profileId === profileId),
        ...suite.registry.profiles.filter((profile) => profile.profileId !== profileId),
      ],
    };
    const observation = routeByFirstEligible(
      benchmarkCase.request,
      reordered,
      EvalRunConfigSchema.parse(await readJson(rulesConfigFile)).policy,
    );
    expect(evaluateObservation(observation, benchmarkCase)).toEqual({
      status: "accepted",
      reason: "acceptable_selection",
    });
  }
});

test("rules and replay use production routing gates and compare across a declared variant", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-eval-"));
  try {
    const rulesRun = join(root, "rules");
    const replayRun = join(root, "replay");
    const rules = await runEvaluation({
      suiteFile,
      configFile: rulesConfigFile,
      outputDirectory: rulesRun,
      allowLive: false,
      signal: new AbortController().signal,
    });
    const replay = await runEvaluation({
      suiteFile,
      configFile: replayConfigFile,
      outputDirectory: replayRun,
      allowLive: false,
      signal: new AbortController().signal,
    });
    expect(rules).toMatchObject({
      complete: true,
      providerUsage: { kind: "unavailable", observedCount: 0 },
      readiness: { accepted: 2 },
    });
    expect(replay).toMatchObject({
      complete: true,
      total: { accepted: 12, operationalErrors: 0 },
      providerUsage: { kind: "synthetic", observedCount: 10 },
    });
    const comparison = await compareEvaluations(rulesRun, replayRun, ["variant"]);
    expect(comparison).toMatchObject({
      compatible: true,
      complete: true,
      pairedRows: 12,
      deltas: { accepted: 6, observedInputTokens: null, observedOutputTokens: null },
    });
    const missingRows = (await readJsonLines(join(replayRun, "results.jsonl")))
      .map((row) => EvalRowSchema.parse(row))
      .filter(({ theme }) => theme === "missing_context");
    expect(missingRows.every(({ observation }) => observation?.attempts === 0)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational abstention cannot score as an accepted intentional abstention", async () => {
  const suite = EvalSuiteSchema.parse(await readJson(suiteFile));
  const benchmarkCase = suite.cases.find(({ theme }) => theme === "local_edit");
  if (benchmarkCase === undefined) throw new Error("suitability case missing");
  const rules = routeByFirstEligible(
    benchmarkCase.request,
    suite.registry,
    EvalRunConfigSchema.parse(await readJson(rulesConfigFile)).policy,
  );
  expect(
    evaluateObservation(
      {
        ...rules,
        decision: "abstained",
        selectedProfileId: undefined,
        reason: "provider_disabled",
      },
      benchmarkCase,
    ),
  ).toEqual({ status: "error", reason: "operational_error" });
});

test("saved-request admissibility rejects a mixed known and unknown candidate list", async () => {
  const suite = EvalSuiteSchema.parse(await readJson(suiteFile));
  const config = EvalRunConfigSchema.parse(await readJson(rulesConfigFile));
  const benchmarkCase = suite.cases.find(({ theme }) => theme === "local_edit");
  if (benchmarkCase === undefined) throw new Error("suitability case missing");
  const profileId = benchmarkCase.labels.acceptableProfileIds[0];
  if (profileId === undefined) throw new Error("acceptable profile missing");
  expect(
    isAdmissibleSelection(
      profileId,
      {
        ...benchmarkCase.request,
        candidateProfileIds: [profileId, "unknown-profile"],
      },
      suite.registry,
      config.policy,
    ),
  ).toBe(false);
});

test("request budgets and caller cancellation publish every planned row", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-eval-stop-"));
  try {
    const config = EvalRunConfigSchema.parse(await readJson(replayConfigFile));
    const budgetConfig = join(root, "budget.json");
    await writeFile(budgetConfig, JSON.stringify({ ...config, maxRequests: 1 }));
    const budgetRun = join(root, "budget-run");
    const budgetSummary = await runEvaluation({
      suiteFile,
      configFile: budgetConfig,
      outputDirectory: budgetRun,
      allowLive: false,
      signal: new AbortController().signal,
    });
    expect(budgetSummary).toMatchObject({ complete: false, total: { planned: 12, notRun: 9 } });
    expect(EvalSummarySchema.parse(await readJson(join(budgetRun, "summary.json")))).toEqual(
      budgetSummary,
    );

    const cancelled = new AbortController();
    cancelled.abort();
    const cancelledRun = join(root, "cancelled-run");
    const cancelledSummary = await runEvaluation({
      suiteFile,
      configFile: replayConfigFile,
      outputDirectory: cancelledRun,
      allowLive: false,
      signal: cancelled.signal,
    });
    expect(cancelledSummary).toMatchObject({
      complete: false,
      total: { planned: 12, observed: 0, notRun: 12 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run deadline cancels an in-flight SDK call and finalizes every remaining row", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-eval-deadline-"));
  try {
    const config = EvalRunConfigSchema.parse(await readJson(replayConfigFile));
    const liveConfig = join(root, "live.json");
    await writeFile(
      liveConfig,
      JSON.stringify({
        ...config,
        mode: "live",
        policy: { ...config.policy, deadlineMs: 1_000 },
        totalDeadlineMs: 1_000,
      }),
    );
    let calls = 0;
    const output = join(root, "run");
    const summary = await runEvaluation({
      suiteFile,
      configFile: liveConfig,
      outputDirectory: output,
      allowLive: true,
      apiKey: "synthetic-test-key",
      fetch: async () => {
        calls += 1;
        await Bun.sleep(1_200);
        return Response.json({});
      },
      signal: new AbortController().signal,
    });
    expect(calls).toBe(1);
    expect(summary).toMatchObject({
      complete: false,
      total: { planned: 12, observed: 1, cancelled: 1, notRun: 11 },
    });
    const comparison = await compareEvaluations(output, output, []);
    expect(comparison).toMatchObject({ compatible: true, complete: false, pairedRows: 12 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comparison rejects undeclared changes and tampered bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-eval-integrity-"));
  try {
    const rulesRun = join(root, "rules");
    const replayRun = join(root, "replay");
    await runEvaluation({
      suiteFile,
      configFile: rulesConfigFile,
      outputDirectory: rulesRun,
      allowLive: false,
      signal: new AbortController().signal,
    });
    await runEvaluation({
      suiteFile,
      configFile: replayConfigFile,
      outputDirectory: replayRun,
      allowLive: false,
      signal: new AbortController().signal,
    });
    expect((await compareEvaluations(rulesRun, replayRun, [])).compatible).toBe(false);
    const replayConfig = EvalRunConfigSchema.parse(await readJson(replayConfigFile));
    const changedPolicyConfig = join(root, "changed-policy.json");
    await writeFile(
      changedPolicyConfig,
      JSON.stringify({
        ...replayConfig,
        policy: { ...replayConfig.policy, confidenceThreshold: 0.1 },
      }),
    );
    const changedPolicyRun = join(root, "changed-policy");
    await runEvaluation({
      suiteFile,
      configFile: changedPolicyConfig,
      outputDirectory: changedPolicyRun,
      allowLive: false,
      signal: new AbortController().signal,
    });
    const changedManifestFile = join(changedPolicyRun, "manifest.json");
    const changedManifest = EvalManifestSchema.parse(await readJson(changedManifestFile));
    await writeFile(
      changedManifestFile,
      JSON.stringify({
        ...changedManifest,
        implementation: {
          ...changedManifest.implementation,
          routerDigest: `sha256:${"e".repeat(64)}`,
          promptDigest: `sha256:${"d".repeat(64)}`,
        },
      }),
    );
    expect(
      (
        await compareEvaluations(replayRun, changedPolicyRun, [
          "policy",
          "implementation",
          "prompt",
        ])
      ).compatible,
    ).toBe(true);
    expect(
      (await compareEvaluations(replayRun, changedPolicyRun, ["policy", "implementation"]))
        .compatible,
    ).toBe(false);
    const requestLimitConfig = join(root, "request-limit-policy.json");
    await writeFile(
      requestLimitConfig,
      JSON.stringify({
        ...replayConfig,
        policy: { ...replayConfig.policy, maxRequestBytes: 1_024 },
      }),
    );
    const requestLimitRun = join(root, "request-limit-policy");
    const requestLimitSummary = await runEvaluation({
      suiteFile,
      configFile: requestLimitConfig,
      outputDirectory: requestLimitRun,
      allowLive: false,
      signal: new AbortController().signal,
    });
    expect(requestLimitSummary.total).toMatchObject({
      observed: 12,
      operationalErrors: 10,
      notRun: 0,
    });
    expect((await compareEvaluations(replayRun, requestLimitRun, ["policy"])).compatible).toBe(
      true,
    );
    const resultFile = join(replayRun, "results.jsonl");
    const originalResults = await readFile(resultFile, "utf8");
    const rows = (await readJsonLines(resultFile)).map((row) => EvalRowSchema.parse(row));
    const first = rows[0];
    if (first?.observation === null || first === undefined) throw new Error("observation missing");
    rows[0] = EvalRowSchema.parse({
      ...first,
      observation: {
        ...first.observation,
        binding: { ...first.observation.binding, inputDigest: `sha256:${"f".repeat(64)}` },
      },
    });
    await writeFile(resultFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await expect(compareEvaluations(rulesRun, replayRun, ["variant"])).rejects.toThrow(
      "observation binding mismatch",
    );
    const forbidden = rows[0];
    if (forbidden?.observation === null || forbidden === undefined) {
      throw new Error("observation missing");
    }
    rows[0] = EvalRowSchema.parse({
      ...forbidden,
      observation: {
        ...forbidden.observation,
        binding: first.observation.binding,
        selectedProfileId: "unregistered-profile",
      },
      verdict: { status: "rejected", reason: "wrong_selection" },
    });
    await writeFile(resultFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await expect(compareEvaluations(rulesRun, replayRun, ["variant"])).rejects.toThrow(
      "ineligible selected profile",
    );
    await writeFile(resultFile, `${originalResults}${originalResults.split("\n")[0]}\n`);
    await expect(compareEvaluations(rulesRun, replayRun, ["variant"])).rejects.toThrow(
      "duplicate result case",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported runtime identities fail before reserving output", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-eval-override-"));
  try {
    const config = EvalRunConfigSchema.parse(await readJson(replayConfigFile));
    const configFile = join(root, "unsupported.json");
    const output = join(root, "output");
    await writeFile(configFile, JSON.stringify({ ...config, model: "future-model" }));
    await expect(
      runEvaluation({
        suiteFile,
        configFile,
        outputDirectory: output,
        allowLive: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("unsupported model override");
    expect(await Bun.file(join(output, "manifest.json")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
