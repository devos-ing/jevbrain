import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { readJson } from "../benchmark/io.ts";
import {
  ContextBenchmarkSuiteSchema,
  ContextFixtureSchema,
  type ContextRunManifest,
  ContextRunManifestSchema,
  type ContextRunResult,
  ContextRunResultSchema,
  type ContextRunSummary,
  ContextRunSummarySchema,
} from "./benchmark-contracts.ts";
import { contentDigest, contextDigest } from "./digest.ts";
import { splitContext } from "./split-context.ts";
import { matchesContextExpectation } from "./verify-context-outcome.ts";

const projectRoot = resolve(import.meta.dir, "../..");
const PackageIdentitySchema = z.object({
  name: z.literal("jevbrain"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});

async function sourceFingerprint(paths: readonly string[]): Promise<`sha256:${string}`> {
  return contentDigest((await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n"));
}

export async function replayContextSuite(
  suiteFile: string,
  outputDirectory: string,
): Promise<ContextRunSummary> {
  const suitePath = resolve(suiteFile);
  const outputPath = resolve(outputDirectory);
  const suite = ContextBenchmarkSuiteSchema.parse(await readJson(suitePath));
  const packageIdentity = PackageIdentitySchema.parse(
    await readJson(join(projectRoot, "package.json")),
  );
  const runId = crypto.randomUUID();
  const cases: ContextRunManifest["cases"] = [];
  const results: ContextRunResult[] = [];

  for (const benchmarkCase of suite.cases) {
    const fixture = ContextFixtureSchema.parse(
      await readJson(resolve(dirname(suitePath), benchmarkCase.fixtureFile)),
    );
    const outcome = splitContext(fixture.request, fixture.trustedPolicy);
    results.push(
      ContextRunResultSchema.parse({
        schemaVersion: "context-run-v1",
        runId,
        caseId: benchmarkCase.caseId,
        caseVersion: benchmarkCase.caseVersion,
        outcome,
        checkStatus: matchesContextExpectation(outcome, benchmarkCase.expected)
          ? "passed"
          : "failed",
        workerStatus: "not_run",
        qualityStatus: "not_run",
        runtimeEnforcement: "not_run",
      }),
    );
    cases.push({
      caseId: benchmarkCase.caseId,
      caseVersion: benchmarkCase.caseVersion,
      fixtureId: fixture.fixtureId,
      fixtureVersion: fixture.fixtureVersion,
      fixtureDigest: contextDigest(fixture),
      expectationDigest: contextDigest(benchmarkCase.expected),
      expected: benchmarkCase.expected,
    });
  }

  const manifest = ContextRunManifestSchema.parse({
    schemaVersion: "context-run-v1",
    mode: "replay",
    stage: "context-v1",
    runId,
    createdAt: new Date().toISOString(),
    implementation: {
      ...packageIdentity,
      bunVersion: Bun.version,
      fingerprint: await sourceFingerprint([
        resolve(import.meta.dir, "replay.ts"),
        resolve(import.meta.dir, "split-context.ts"),
        resolve(import.meta.dir, "contracts.ts"),
        resolve(import.meta.dir, "digest.ts"),
      ]),
    },
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    suiteDigest: contextDigest(suite),
    splitterVersion: suite.splitterVersion,
    splitterDigest: await sourceFingerprint([
      resolve(import.meta.dir, "split-context.ts"),
      resolve(import.meta.dir, "contracts.ts"),
      resolve(import.meta.dir, "digest.ts"),
    ]),
    verifierVersion: suite.verifierVersion,
    verifierDigest: await sourceFingerprint([
      resolve(import.meta.dir, "verify-context-outcome.ts"),
      resolve(import.meta.dir, "benchmark-contracts.ts"),
      resolve(import.meta.dir, "contracts.ts"),
      resolve(import.meta.dir, "digest.ts"),
    ]),
    cases,
  });
  const summary = ContextRunSummarySchema.parse({
    runId,
    total: results.length,
    passed: results.filter(({ checkStatus }) => checkStatus === "passed").length,
    failed: results.filter(({ checkStatus }) => checkStatus === "failed").length,
    workerStatus: "not_run",
    qualityStatus: "not_run",
    runtimeEnforcement: "not_run",
  });
  await publishContextRun(outputPath, manifest, results, summary);
  return summary;
}

async function publishContextRun(
  outputPath: string,
  manifest: ContextRunManifest,
  results: readonly ContextRunResult[],
  summary: ContextRunSummary,
): Promise<void> {
  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = await mkdtemp(join(parent, ".jevbrain-context-"));
  let reservedOutput = false;
  try {
    await writeFile(
      join(temporaryPath, "results.jsonl"),
      `${results.map((result) => JSON.stringify(result)).join("\n")}\n`,
    );
    await writeFile(join(temporaryPath, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(
      join(temporaryPath, "summary.md"),
      `# Context replay ${summary.runId}\n\n${summary.passed}/${summary.total} context checks passed. Worker execution, quality evaluation, and runtime enforcement were not run.\n`,
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
}
