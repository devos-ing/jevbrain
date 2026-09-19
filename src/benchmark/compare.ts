import { join, resolve } from "node:path";
import {
  type ReplayComparison,
  ReplayComparisonSchema,
  type ReplayManifest,
  ReplayManifestSchema,
  type ReplayResult,
  ReplayResultSchema,
} from "../contracts.ts";
import { digestJson, parseAll, readJson, readJsonLines } from "./io.ts";

type LoadedRun = { manifest: ReplayManifest; results: Map<string, ReplayResult> };

function verifyManifestDigests(manifest: ReplayManifest): void {
  for (const item of manifest.cases) {
    if (
      digestJson(item.input) !== item.inputDigest ||
      digestJson(item.profiles) !== item.profilesDigest ||
      digestJson(item.recording) !== item.recordingDigest ||
      digestJson(item.expected) !== item.expectationDigest
    ) {
      throw new Error(`manifest snapshot digest mismatch for case ${item.caseId}`);
    }
  }
}

async function loadRun(directory: string): Promise<LoadedRun> {
  const path = resolve(directory);
  const manifest = ReplayManifestSchema.parse(await readJson(join(path, "manifest.json")));
  verifyManifestDigests(manifest);
  const rows = parseAll(ReplayResultSchema, await readJsonLines(join(path, "results.jsonl")));
  const declared = new Map(manifest.cases.map((item) => [item.caseId, item]));
  const results = new Map<string, ReplayResult>();
  for (const row of rows) {
    if (row.runId !== manifest.runId)
      throw new Error(`result runId mismatch for case ${row.caseId}`);
    const declaration = declared.get(row.caseId);
    if (!declaration) throw new Error(`foreign result case: ${row.caseId}`);
    if (row.caseVersion !== declaration.caseVersion)
      throw new Error(`result caseVersion mismatch for case ${row.caseId}`);
    if (results.has(row.caseId)) throw new Error(`duplicate result case: ${row.caseId}`);
    results.set(row.caseId, row);
  }
  for (const caseId of declared.keys()) {
    if (!results.has(caseId)) throw new Error(`missing result case: ${caseId}`);
  }
  return { manifest, results };
}

function compatibleIdentity(
  left: ReplayManifest["cases"][number],
  right: ReplayManifest["cases"][number],
): boolean {
  return (
    left.caseVersion === right.caseVersion &&
    left.inputDigest === right.inputDigest &&
    left.profilesDigest === right.profilesDigest &&
    left.recordingDigest === right.recordingDigest &&
    left.expectationDigest === right.expectationDigest
  );
}

function semanticResult(result: ReplayResult): unknown {
  return {
    schemaVersion: result.schemaVersion,
    caseId: result.caseId,
    caseVersion: result.caseVersion,
    observation: result.observation,
    checkStatus: result.checkStatus,
    workerStatus: result.workerStatus,
    qualityStatus: result.qualityStatus,
    providerUsage: result.providerUsage,
  };
}

export async function compareRuns(
  baselineDirectory: string,
  candidateDirectory: string,
): Promise<ReplayComparison> {
  const baseline = await loadRun(baselineDirectory);
  const candidate = await loadRun(candidateDirectory);
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
  if (baseline.manifest.verifierVersion !== candidate.manifest.verifierVersion) {
    issues.push("verifier version differs");
  }
  if (baseline.manifest.verifierDigest !== candidate.manifest.verifierDigest)
    issues.push("verifier identity differs");
  for (const baselineCase of baseline.manifest.cases) {
    const candidateCase = candidateCases.get(baselineCase.caseId);
    if (!candidateCase || !compatibleIdentity(baselineCase, candidateCase)) {
      incompatibleCaseIds.push(baselineCase.caseId);
      continue;
    }
    pairedCaseIds.push(baselineCase.caseId);
    const baselineResult = baseline.results.get(baselineCase.caseId);
    const candidateResult = candidate.results.get(baselineCase.caseId);
    if (
      baselineResult === undefined ||
      candidateResult === undefined ||
      digestJson(semanticResult(baselineResult)) !== digestJson(semanticResult(candidateResult))
    ) {
      changedCaseIds.push(baselineCase.caseId);
    }
  }
  for (const candidateCase of candidate.manifest.cases) {
    if (!baselineIds.has(candidateCase.caseId)) incompatibleCaseIds.push(candidateCase.caseId);
  }
  if (incompatibleCaseIds.length > 0)
    issues.push("case/input/recording/expectation identities differ");
  const comparison = {
    schemaVersion: "m0.1" as const,
    baselineRunId: baseline.manifest.runId,
    candidateRunId: candidate.manifest.runId,
    compatible: issues.length === 0,
    semanticEqual: issues.length === 0 && changedCaseIds.length === 0,
    pairedCaseIds,
    changedCaseIds,
    incompatibleCaseIds: [...new Set(incompatibleCaseIds)].sort(),
    issues,
  };
  return ReplayComparisonSchema.parse(comparison);
}
