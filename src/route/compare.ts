import { join, resolve } from "node:path";
import { digestJson, parseAll, readJson, readJsonLines } from "../benchmark/io.ts";
import {
  type RoutingRunComparison,
  RoutingRunComparisonSchema,
  type RoutingRunManifest,
  RoutingRunManifestSchema,
  type RoutingRunResult,
  RoutingRunResultSchema,
} from "./benchmark-contracts.ts";
import { matchesRoutingExpectation } from "./verify-routing-outcome.ts";

type LoadedRun = { manifest: RoutingRunManifest; results: Map<string, RoutingRunResult> };

async function loadRun(directory: string): Promise<LoadedRun> {
  const path = resolve(directory);
  const manifest = RoutingRunManifestSchema.parse(await readJson(join(path, "manifest.json")));
  const rows = parseAll(RoutingRunResultSchema, await readJsonLines(join(path, "results.jsonl")));
  const declarations = new Map(manifest.cases.map((item) => [item.caseId, item]));
  const results = new Map<string, RoutingRunResult>();
  for (const declaration of manifest.cases) {
    if (
      digestJson({
        expected: declaration.expected,
        expectedBinding: declaration.expectedBinding,
      }) !== declaration.expectationDigest
    )
      throw new Error(`expectation digest mismatch: ${declaration.caseId}`);
  }
  for (const row of rows) {
    const declaration = declarations.get(row.caseId);
    if (row.runId !== manifest.runId) throw new Error(`result runId mismatch: ${row.caseId}`);
    if (declaration === undefined) throw new Error(`foreign result case: ${row.caseId}`);
    if (row.caseVersion !== declaration.caseVersion)
      throw new Error(`caseVersion mismatch: ${row.caseId}`);
    if (JSON.stringify(row.outcome.binding) !== JSON.stringify(declaration.expectedBinding))
      throw new Error(`result binding mismatch: ${row.caseId}`);
    const shouldPass = matchesRoutingExpectation(
      row.outcome,
      declaration.expected,
      declaration.expectedBinding,
    );
    if ((row.checkStatus === "passed") !== shouldPass)
      throw new Error(`result checkStatus mismatch: ${row.caseId}`);
    if (results.has(row.caseId)) throw new Error(`duplicate result case: ${row.caseId}`);
    results.set(row.caseId, row);
  }
  for (const caseId of declarations.keys())
    if (!results.has(caseId)) throw new Error(`missing result case: ${caseId}`);
  return { manifest, results };
}

export async function compareRoutingRuns(
  baselineDirectory: string,
  candidateDirectory: string,
): Promise<RoutingRunComparison> {
  const baseline = await loadRun(baselineDirectory);
  const candidate = await loadRun(candidateDirectory);
  const issues: string[] = [];
  if (
    baseline.manifest.suiteId !== candidate.manifest.suiteId ||
    baseline.manifest.suiteVersion !== candidate.manifest.suiteVersion ||
    baseline.manifest.suiteDigest !== candidate.manifest.suiteDigest
  )
    issues.push("suite identity differs");
  if (
    baseline.manifest.verifierVersion !== candidate.manifest.verifierVersion ||
    baseline.manifest.verifierDigest !== candidate.manifest.verifierDigest
  )
    issues.push("verifier identity differs");
  const candidateCases = new Map(candidate.manifest.cases.map((item) => [item.caseId, item]));
  const baselineIds = new Set(baseline.manifest.cases.map(({ caseId }) => caseId));
  const pairedCaseIds: string[] = [];
  const incompatibleCaseIds: string[] = [];
  const changedCaseIds: string[] = [];
  for (const leftCase of baseline.manifest.cases) {
    const rightCase = candidateCases.get(leftCase.caseId);
    if (
      rightCase === undefined ||
      leftCase.caseVersion !== rightCase.caseVersion ||
      leftCase.fixtureId !== rightCase.fixtureId ||
      leftCase.fixtureVersion !== rightCase.fixtureVersion ||
      leftCase.fixtureDigest !== rightCase.fixtureDigest ||
      leftCase.expectationDigest !== rightCase.expectationDigest
    ) {
      incompatibleCaseIds.push(leftCase.caseId);
      continue;
    }
    pairedCaseIds.push(leftCase.caseId);
    const left = baseline.results.get(leftCase.caseId);
    const right = candidate.results.get(leftCase.caseId);
    if (left === undefined || right === undefined || semanticDigest(left) !== semanticDigest(right))
      changedCaseIds.push(leftCase.caseId);
  }
  for (const item of candidate.manifest.cases)
    if (!baselineIds.has(item.caseId)) incompatibleCaseIds.push(item.caseId);
  if (incompatibleCaseIds.length > 0) issues.push("case or fixture identity differs");
  return RoutingRunComparisonSchema.parse({
    schemaVersion: "routing-run-v1",
    baselineRunId: baseline.manifest.runId,
    candidateRunId: candidate.manifest.runId,
    compatible: issues.length === 0,
    semanticEqual: issues.length === 0 && changedCaseIds.length === 0,
    pairedCaseIds,
    changedCaseIds,
    incompatibleCaseIds: [...new Set(incompatibleCaseIds)].sort(),
    issues,
  });
}

function semanticDigest(result: RoutingRunResult): string {
  return digestJson({
    schemaVersion: result.schemaVersion,
    caseId: result.caseId,
    caseVersion: result.caseVersion,
    outcome: {
      ...result.outcome,
      binding: { ...result.outcome.binding },
      metadata: { ...result.outcome.metadata, elapsedMs: 0 },
    },
    checkStatus: result.checkStatus,
    workerStatus: result.workerStatus,
    qualityStatus: result.qualityStatus,
  });
}
