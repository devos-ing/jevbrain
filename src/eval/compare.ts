import { join, resolve } from "node:path";
import { z } from "zod";
import { digestJson, parseAll, readJson, readJsonLines } from "../benchmark/io.ts";
import {
  EvalAxisSchema,
  EvalComparisonSchema,
  type EvalManifest,
  EvalManifestSchema,
  type EvalRow,
  EvalRowSchema,
  EvalSuiteSchema,
  type EvalSummary,
  EvalSummarySchema,
} from "./contracts.ts";
import {
  evaluateObservation,
  fixtureDigest,
  isAdmissibleSelection,
  summarizeEval,
} from "./verify.ts";

type LoadedEval = { manifest: EvalManifest; rows: Map<string, EvalRow>; summary: EvalSummary };

export async function compareEvaluations(
  baselineDirectory: string,
  candidateDirectory: string,
  allowedAxesInput: readonly unknown[],
) {
  const allowedAxes = z.array(EvalAxisSchema).parse(allowedAxesInput);
  if (new Set(allowedAxes).size !== allowedAxes.length)
    throw new Error("duplicate comparison axis");
  const baseline = await loadEvaluation(baselineDirectory);
  const candidate = await loadEvaluation(candidateDirectory);
  const actualDifferences = findDifferences(baseline.manifest, candidate.manifest);
  const issues: string[] = [];
  if (
    baseline.manifest.suiteId !== candidate.manifest.suiteId ||
    baseline.manifest.suiteVersion !== candidate.manifest.suiteVersion ||
    baseline.manifest.suiteDigest !== candidate.manifest.suiteDigest
  ) {
    issues.push("suite identity differs");
  }
  if (baseline.manifest.registryDigest !== candidate.manifest.registryDigest) {
    issues.push("registry identity differs");
  }
  if (
    baseline.manifest.verifierVersion !== candidate.manifest.verifierVersion ||
    baseline.manifest.verifierDigest !== candidate.manifest.verifierDigest
  ) {
    issues.push("verifier identity differs");
  }
  for (const difference of actualDifferences) {
    if (!allowedAxes.includes(difference.axis))
      issues.push(`undeclared axis differs: ${difference.axis}`);
  }
  const candidateCases = new Map(candidate.manifest.cases.map((item) => [item.caseId, item]));
  const baselineIds = new Set(baseline.manifest.cases.map(({ caseId }) => caseId));
  const decisionChanges: string[] = [];
  const verdictChanges: string[] = [];
  let pairedRows = 0;
  for (const leftCase of baseline.manifest.cases) {
    const rightCase = candidateCases.get(leftCase.caseId);
    if (
      rightCase === undefined ||
      leftCase.caseVersion !== rightCase.caseVersion ||
      leftCase.fixtureDigest !== rightCase.fixtureDigest ||
      digestJson(leftCase.labels) !== digestJson(rightCase.labels)
    ) {
      issues.push(`case identity differs: ${leftCase.caseId}`);
      continue;
    }
    const left = baseline.rows.get(leftCase.caseId);
    const right = candidate.rows.get(leftCase.caseId);
    if (left === undefined || right === undefined)
      throw new Error("validated row unexpectedly missing");
    pairedRows += 1;
    if (decisionDigest(left) !== decisionDigest(right)) decisionChanges.push(leftCase.caseId);
    if (digestJson(left.verdict) !== digestJson(right.verdict))
      verdictChanges.push(leftCase.caseId);
  }
  for (const rightCase of candidate.manifest.cases) {
    if (!baselineIds.has(rightCase.caseId))
      issues.push(`foreign candidate case: ${rightCase.caseId}`);
  }
  const baselineMedian = baseline.summary.total.latency.medianMs;
  const candidateMedian = candidate.summary.total.latency.medianMs;
  const comparableUsage =
    baseline.summary.providerUsage.kind !== "unavailable" &&
    baseline.summary.providerUsage.kind === candidate.summary.providerUsage.kind;
  return EvalComparisonSchema.parse({
    schemaVersion: "routing-eval-comparison-v1",
    baselineRunId: baseline.manifest.runId,
    candidateRunId: candidate.manifest.runId,
    compatible: issues.length === 0,
    complete: baseline.summary.complete && candidate.summary.complete,
    allowedAxes,
    actualDifferences,
    pairedRows,
    decisionChanges,
    verdictChanges,
    baselineSummary: baseline.summary,
    candidateSummary: candidate.summary,
    deltas: {
      accepted: candidate.summary.total.accepted - baseline.summary.total.accepted,
      operationalErrors:
        candidate.summary.total.operationalErrors - baseline.summary.total.operationalErrors,
      medianLatencyMs:
        baselineMedian === null || candidateMedian === null
          ? null
          : candidateMedian - baselineMedian,
      observedInputTokens: comparableUsage
        ? candidate.summary.providerUsage.inputTokens - baseline.summary.providerUsage.inputTokens
        : null,
      observedOutputTokens: comparableUsage
        ? candidate.summary.providerUsage.outputTokens - baseline.summary.providerUsage.outputTokens
        : null,
    },
    issues,
  });
}

async function loadEvaluation(directory: string): Promise<LoadedEval> {
  const path = resolve(directory);
  const manifest = EvalManifestSchema.parse(await readJson(join(path, "manifest.json")));
  const suite = EvalSuiteSchema.parse(await readJson(join(path, "suite.json")));
  if (digestJson(suite) !== manifest.suiteDigest) throw new Error("suite snapshot digest mismatch");
  if (digestJson(manifest.registry) !== manifest.registryDigest) {
    throw new Error("registry snapshot digest mismatch");
  }
  if (digestJson(manifest.config) !== manifest.configDigest)
    throw new Error("config digest mismatch");
  if (
    suite.suiteId !== manifest.suiteId ||
    suite.suiteVersion !== manifest.suiteVersion ||
    digestJson(suite.registry) !== manifest.registryDigest ||
    digestJson(suite.registry) !== digestJson(manifest.registry)
  ) {
    throw new Error("manifest suite binding mismatch");
  }
  if (suite.cases.length !== manifest.cases.length) {
    throw new Error("manifest case set mismatch");
  }
  const suiteCases = new Map(suite.cases.map((item) => [item.caseId, item]));
  for (const declaration of manifest.cases) {
    const suiteCase = suiteCases.get(declaration.caseId);
    if (suiteCase === undefined) throw new Error(`manifest foreign case: ${declaration.caseId}`);
    const { recordedResponse, ...safeCase } = suiteCase;
    if (
      digestJson(safeCase) !==
        digestJson({
          caseId: declaration.caseId,
          caseVersion: declaration.caseVersion,
          split: declaration.split,
          theme: declaration.theme,
          request: declaration.request,
          labels: declaration.labels,
        }) ||
      declaration.recordingDigest !==
        (recordedResponse === undefined ? null : digestJson(recordedResponse))
    ) {
      throw new Error(`manifest case snapshot mismatch: ${declaration.caseId}`);
    }
  }
  const rows = parseAll(EvalRowSchema, await readJsonLines(join(path, "results.jsonl")));
  const declarations = new Map(manifest.cases.map((item) => [item.caseId, item]));
  const rowMap = new Map<string, EvalRow>();
  for (const row of rows) {
    const declaration = declarations.get(row.caseId);
    if (declaration === undefined) throw new Error(`foreign result case: ${row.caseId}`);
    if (rowMap.has(row.caseId)) throw new Error(`duplicate result case: ${row.caseId}`);
    if (
      row.runId !== manifest.runId ||
      row.caseVersion !== declaration.caseVersion ||
      row.split !== declaration.split ||
      row.theme !== declaration.theme
    ) {
      throw new Error(`result binding mismatch: ${row.caseId}`);
    }
    const benchmarkCase = {
      caseId: declaration.caseId,
      caseVersion: declaration.caseVersion,
      split: declaration.split,
      theme: declaration.theme,
      request: declaration.request,
      labels: declaration.labels,
    };
    if (
      fixtureDigest(benchmarkCase) !== declaration.fixtureDigest ||
      row.fixtureDigest !== declaration.fixtureDigest ||
      row.labelsDigest !== digestJson(declaration.labels)
    ) {
      throw new Error(`fixture identity mismatch: ${row.caseId}`);
    }
    const expectedVerdict =
      row.observation === null
        ? row.executionStatus === "not_run" && row.verdict.status === "not_run"
          ? row.verdict
          : { status: "error", reason: "operational_error" }
        : evaluateObservation(row.observation, benchmarkCase);
    if (digestJson(expectedVerdict) !== digestJson(row.verdict)) {
      throw new Error(`verdict mismatch: ${row.caseId}`);
    }
    if (row.observation === null) {
      const validEmptyState =
        (row.executionStatus === "not_run" && row.verdict.status === "not_run") ||
        (row.executionStatus === "failed" && row.verdict.reason === "operational_error");
      if (!validEmptyState) throw new Error(`execution state mismatch: ${row.caseId}`);
    } else {
      const expectedExecutionStatus =
        row.observation.decision === "cancelled"
          ? "cancelled"
          : row.verdict.status === "error"
            ? "failed"
            : "completed";
      if (row.executionStatus !== expectedExecutionStatus) {
        throw new Error(`execution state mismatch: ${row.caseId}`);
      }
      validateObservation(row, declaration, manifest);
    }
    rowMap.set(row.caseId, row);
  }
  for (const caseId of declarations.keys()) {
    if (!rowMap.has(caseId)) throw new Error(`missing result case: ${caseId}`);
  }
  const summary = EvalSummarySchema.parse(await readJson(join(path, "summary.json")));
  if (
    [...rowMap.values()].filter(({ observation }) => observation !== null).length >
      manifest.config.maxCases ||
    [...rowMap.values()].reduce((sum, row) => sum + (row.observation?.attempts ?? 0), 0) >
      manifest.config.maxRequests
  ) {
    throw new Error("execution budget exceeded");
  }
  const recomputed = summarizeEval(manifest.runId, [...rowMap.values()]);
  if (digestJson(summary) !== digestJson(recomputed)) throw new Error("summary mismatch");
  return { manifest, rows: rowMap, summary };
}

function validateObservation(
  row: EvalRow,
  declaration: EvalManifest["cases"][number],
  manifest: EvalManifest,
): void {
  const observation = row.observation;
  if (observation === null) return;
  const expectedBinding = {
    delegationId: declaration.request.delegationId,
    taskId: declaration.request.taskId,
    inputDigest: digestJson(declaration.request),
    registryVersion: manifest.registry.registryVersion,
    registryDigest: manifest.registryDigest,
    policyVersion: manifest.config.policy.policyVersion,
    policyDigest: digestJson(manifest.config.policy),
  };
  if (digestJson(observation.binding) !== digestJson(expectedBinding)) {
    throw new Error(`observation binding mismatch: ${row.caseId}`);
  }
  if (observation.selectedProfileId !== undefined) {
    const eligible = isAdmissibleSelection(
      observation.selectedProfileId,
      declaration.request,
      manifest.registry,
      manifest.config.policy,
    );
    if (!eligible) throw new Error(`ineligible selected profile: ${row.caseId}`);
  }
  if (manifest.config.variant === "rules:first-eligible-v1") {
    if (
      observation.transportMode !== "rules" ||
      observation.attempts !== 0 ||
      observation.provider !== undefined ||
      observation.confidence !== undefined
    ) {
      throw new Error(`rules observation shape mismatch: ${row.caseId}`);
    }
    return;
  }
  if (observation.attempts > 1) throw new Error(`route attempt count mismatch: ${row.caseId}`);
  const enabledZeroSendOutcome =
    observation.attempts === 0 &&
    ((observation.decision === "abstained" && observation.reason === "request_limit_exceeded") ||
      (observation.decision === "cancelled" && observation.reason === "caller_cancelled"));
  const expectedTransport =
    observation.attempts > 0 || enabledZeroSendOutcome ? manifest.config.mode : "disabled";
  if (observation.transportMode !== expectedTransport) {
    throw new Error(`transport mode mismatch: ${row.caseId}`);
  }
  if (
    observation.attempts === 0 &&
    (observation.selectedProfileId !== undefined ||
      observation.provider !== undefined ||
      observation.confidence !== undefined)
  ) {
    throw new Error(`zero-attempt observation shape mismatch: ${row.caseId}`);
  }
  if (observation.provider !== undefined && observation.provider.model !== manifest.config.model) {
    throw new Error(`provider model mismatch: ${row.caseId}`);
  }
}

function findDifferences(left: EvalManifest, right: EvalManifest) {
  const candidates: Array<{
    axis: z.infer<typeof EvalAxisSchema>;
    baseline: string;
    candidate: string;
  }> = [
    { axis: "variant", baseline: left.config.variant, candidate: right.config.variant },
    {
      axis: "policy",
      baseline: digestJson(left.config.policy),
      candidate: digestJson(right.config.policy),
    },
    {
      axis: "execution",
      baseline: digestJson({
        maxCases: left.config.maxCases,
        repeats: left.config.repeats,
        maxRequests: left.config.maxRequests,
        totalDeadlineMs: left.config.totalDeadlineMs,
        routeDeadlineMs: left.config.policy.deadlineMs,
      }),
      candidate: digestJson({
        maxCases: right.config.maxCases,
        repeats: right.config.repeats,
        maxRequests: right.config.maxRequests,
        totalDeadlineMs: right.config.totalDeadlineMs,
        routeDeadlineMs: right.config.policy.deadlineMs,
      }),
    },
    {
      axis: "implementation",
      baseline: digestJson(left.implementation),
      candidate: digestJson(right.implementation),
    },
    { axis: "model", baseline: left.config.model, candidate: right.config.model },
    {
      axis: "prompt",
      baseline: `${left.config.promptVersion}:${left.implementation.promptDigest}`,
      candidate: `${right.config.promptVersion}:${right.implementation.promptDigest}`,
    },
    { axis: "mode", baseline: left.config.mode, candidate: right.config.mode },
  ];
  return candidates.filter(({ baseline, candidate }) => baseline !== candidate);
}

function decisionDigest(row: EvalRow): string {
  return digestJson(
    row.observation === null
      ? null
      : {
          decision: row.observation.decision,
          selectedProfileId: row.observation.selectedProfileId,
          reason: row.observation.reason,
        },
  );
}
