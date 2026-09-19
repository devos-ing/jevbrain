import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  type ReplayManifest,
  ReplayManifestSchema,
  ReplayRecordingSchema,
  type ReplayResult,
  ReplayResultSchema,
  ReplaySuiteSchema,
  type ReplaySummary,
  ReplaySummarySchema,
} from "../contracts.ts";
import { validateRecordedResponse } from "../routing/validate-recorded-response.ts";
import { digest, digestJson, readJson } from "./io.ts";
import { matchesExpectation } from "./verify-observation.ts";

const projectRoot = resolve(import.meta.dir, "../..");
const PackageIdentitySchema = z.object({
  name: z.literal("jevbrain"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});

async function implementationFingerprint(): Promise<`sha256:${string}`> {
  const files = [
    resolve(import.meta.dir, "replay.ts"),
    resolve(import.meta.dir, "../routing/validate-recorded-response.ts"),
    resolve(import.meta.dir, "../contracts.ts"),
  ];
  return digest((await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n"));
}

async function verifierFingerprint(): Promise<`sha256:${string}`> {
  const files = [
    resolve(import.meta.dir, "verify-observation.ts"),
    resolve(import.meta.dir, "../contracts.ts"),
  ];
  return digest((await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n"));
}

export async function replaySuite(
  suiteFile: string,
  outputDirectory: string,
): Promise<ReplaySummary> {
  const suitePath = resolve(suiteFile);
  const outputPath = resolve(outputDirectory);
  const suite = ReplaySuiteSchema.parse(await readJson(suitePath));
  const packageJson = await readJson(join(projectRoot, "package.json"));
  const packageIdentity = PackageIdentitySchema.parse(packageJson);
  const runId = crypto.randomUUID();
  const manifestCases: ReplayManifest["cases"] = [];
  const results: ReplayResult[] = [];

  for (const replayCase of suite.cases) {
    const recordingPath = resolve(dirname(suitePath), replayCase.recordingFile);
    const recording = ReplayRecordingSchema.parse(await readJson(recordingPath));
    if (recording.caseId !== replayCase.caseId || recording.inputId !== replayCase.input.inputId) {
      throw new Error(`recording identity mismatch for case ${replayCase.caseId}`);
    }
    const observation = validateRecordedResponse(
      replayCase.input,
      replayCase.profiles,
      recording.responseText,
    );
    const result = ReplayResultSchema.parse({
      schemaVersion: "m0.1",
      runId,
      caseId: replayCase.caseId,
      caseVersion: replayCase.caseVersion,
      observation,
      checkStatus: matchesExpectation(observation, replayCase.expected) ? "passed" : "failed",
      workerStatus: "not_run",
      qualityStatus: "not_run",
      providerUsage: "unavailable",
    });
    results.push(result);
    manifestCases.push({
      caseId: replayCase.caseId,
      caseVersion: replayCase.caseVersion,
      inputDigest: digestJson(replayCase.input),
      profilesDigest: digestJson(replayCase.profiles),
      recordingDigest: digestJson(recording),
      expectationDigest: digestJson(replayCase.expected),
      input: replayCase.input,
      profiles: replayCase.profiles,
      recording,
      expected: replayCase.expected,
    });
  }

  const manifest = ReplayManifestSchema.parse({
    schemaVersion: "m0.1",
    mode: "replay",
    stage: "contracts-v1",
    runId,
    createdAt: new Date().toISOString(),
    implementation: {
      ...packageIdentity,
      bunVersion: Bun.version,
      fingerprint: await implementationFingerprint(),
    },
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    verifierVersion: suite.verifierVersion,
    verifierDigest: await verifierFingerprint(),
    suiteDigest: digestJson(suite),
    cases: manifestCases,
  });
  const summary: ReplaySummary = ReplaySummarySchema.parse({
    runId,
    total: results.length,
    passed: results.filter(({ checkStatus }) => checkStatus === "passed").length,
    failed: results.filter(({ checkStatus }) => checkStatus === "failed").length,
    workerStatus: "not_run",
    qualityStatus: "not_run",
    providerUsage: "unavailable",
  });

  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = await mkdtemp(join(parent, ".jevbrain-replay-"));
  let reservedOutput = false;
  try {
    await writeFile(
      join(temporaryPath, "results.jsonl"),
      `${results.map((result) => JSON.stringify(result)).join("\n")}\n`,
    );
    await writeFile(join(temporaryPath, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(
      join(temporaryPath, "summary.md"),
      `# Replay ${runId}\n\n${summary.passed}/${summary.total} contract checks passed. Worker execution, quality evaluation, and provider usage were not run.\n`,
    );
    await writeFile(join(temporaryPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(outputPath);
    reservedOutput = true;
    for (const filename of ["results.jsonl", "summary.json", "summary.md", "manifest.json"]) {
      await rename(join(temporaryPath, filename), join(outputPath, filename));
    }
    await rm(temporaryPath, { recursive: true });
  } catch (error: unknown) {
    await rm(temporaryPath, { recursive: true, force: true });
    if (reservedOutput) await rm(outputPath, { recursive: true, force: true });
    throw error;
  }
  return summary;
}
