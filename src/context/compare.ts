import { join, resolve } from "node:path";
import { parseAll, readJson, readJsonLines } from "../benchmark/io.ts";
import {
  type ContextRunComparison,
  ContextRunComparisonSchema,
  type ContextRunManifest,
  ContextRunManifestSchema,
  type ContextRunResult,
  ContextRunResultSchema,
} from "./benchmark-contracts.ts";
import { contextDigest } from "./digest.ts";

type LoadedContextRun = {
  manifest: ContextRunManifest;
  results: Map<string, ContextRunResult>;
};

async function loadContextRun(directory: string): Promise<LoadedContextRun> {
  const path = resolve(directory);
  const manifest = ContextRunManifestSchema.parse(await readJson(join(path, "manifest.json")));
  for (const item of manifest.cases) {
    if (contextDigest(item.expected) !== item.expectationDigest) {
      throw new Error(`expectation digest mismatch for case ${item.caseId}`);
    }
  }
  const rows = parseAll(ContextRunResultSchema, await readJsonLines(join(path, "results.jsonl")));
  const declarations = new Map(manifest.cases.map((item) => [item.caseId, item]));
  const results = new Map<string, ContextRunResult>();
  for (const row of rows) {
    if (row.runId !== manifest.runId)
      throw new Error(`result runId mismatch for case ${row.caseId}`);
    const declaration = declarations.get(row.caseId);
    if (declaration === undefined) throw new Error(`foreign result case: ${row.caseId}`);
    if (row.caseVersion !== declaration.caseVersion)
      throw new Error(`caseVersion mismatch: ${row.caseId}`);
    if (results.has(row.caseId)) throw new Error(`duplicate result case: ${row.caseId}`);
    results.set(row.caseId, row);
  }
  for (const caseId of declarations.keys()) {
    if (!results.has(caseId)) throw new Error(`missing result case: ${caseId}`);
  }
  return { manifest, results };
}

export async function compareContextRuns(
  baselineDirectory: string,
  candidateDirectory: string,
): Promise<ContextRunComparison> {
  const baseline = await loadContextRun(baselineDirectory);
  const candidate = await loadContextRun(candidateDirectory);
  const candidateCases = new Map(candidate.manifest.cases.map((item) => [item.caseId, item]));
  const baselineIds = new Set(baseline.manifest.cases.map(({ caseId }) => caseId));
  const pairedCaseIds: string[] = [];
  const changedCaseIds: string[] = [];
  const incompatibleCaseIds: string[] = [];
  const issues: string[] = [];
  if (
    baseline.manifest.suiteId !== candidate.manifest.suiteId ||
    baseline.manifest.suiteVersion !== candidate.manifest.suiteVersion ||
    baseline.manifest.suiteDigest !== candidate.manifest.suiteDigest
  ) {
    issues.push("suite identity differs");
  }
  if (
    baseline.manifest.verifierVersion !== candidate.manifest.verifierVersion ||
    baseline.manifest.verifierDigest !== candidate.manifest.verifierDigest
  ) {
    issues.push("verifier identity differs");
  }
  for (const baselineCase of baseline.manifest.cases) {
    const candidateCase = candidateCases.get(baselineCase.caseId);
    if (
      candidateCase === undefined ||
      baselineCase.caseVersion !== candidateCase.caseVersion ||
      baselineCase.fixtureId !== candidateCase.fixtureId ||
      baselineCase.fixtureVersion !== candidateCase.fixtureVersion ||
      baselineCase.fixtureDigest !== candidateCase.fixtureDigest ||
      baselineCase.expectationDigest !== candidateCase.expectationDigest
    ) {
      incompatibleCaseIds.push(baselineCase.caseId);
      continue;
    }
    pairedCaseIds.push(baselineCase.caseId);
    const left = baseline.results.get(baselineCase.caseId);
    const right = candidate.results.get(baselineCase.caseId);
    if (
      left === undefined ||
      right === undefined ||
      semanticDigest(left) !== semanticDigest(right)
    ) {
      changedCaseIds.push(baselineCase.caseId);
    }
  }
  for (const candidateCase of candidate.manifest.cases) {
    if (!baselineIds.has(candidateCase.caseId)) incompatibleCaseIds.push(candidateCase.caseId);
  }
  if (incompatibleCaseIds.length > 0) issues.push("case or fixture identity differs");
  return ContextRunComparisonSchema.parse({
    schemaVersion: "context-run-v1",
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

function semanticDigest(result: ContextRunResult): string {
  return contextDigest({
    schemaVersion: result.schemaVersion,
    caseId: result.caseId,
    caseVersion: result.caseVersion,
    outcome: result.outcome,
    checkStatus: result.checkStatus,
    workerStatus: result.workerStatus,
    qualityStatus: result.qualityStatus,
    runtimeEnforcement: result.runtimeEnforcement,
  });
}
