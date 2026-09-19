import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { digest, digestJson, readJson } from "../benchmark/io.ts";
import {
  RoutingBenchmarkSuiteSchema,
  RoutingFixtureSchema,
  type RoutingRunManifest,
  RoutingRunManifestSchema,
  type RoutingRunResult,
  RoutingRunResultSchema,
  type RoutingRunSummary,
  RoutingRunSummarySchema,
} from "./benchmark-contracts.ts";
import { createJevAdvisor } from "./jev-advisor.ts";
import { createTaskRouter } from "./router.ts";
import { matchesRoutingExpectation } from "./verify-routing-outcome.ts";

const PackageSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });
const projectRoot = resolve(import.meta.dir, "../..");

async function fingerprint(paths: readonly string[]): Promise<`sha256:${string}`> {
  return digest((await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n"));
}

export async function replayRoutingSuite(
  suiteFile: string,
  outputDirectory: string,
): Promise<RoutingRunSummary> {
  const suitePath = resolve(suiteFile);
  const suite = RoutingBenchmarkSuiteSchema.parse(await readJson(suitePath));
  const packageInfo = PackageSchema.parse(await readJson(join(projectRoot, "package.json")));
  const runId = crypto.randomUUID();
  const cases: RoutingRunManifest["cases"] = [];
  const results: RoutingRunResult[] = [];
  for (const benchmarkCase of suite.cases) {
    const fixture = RoutingFixtureSchema.parse(
      await readJson(resolve(dirname(suitePath), benchmarkCase.fixtureFile)),
    );
    const advisor = createJevAdvisor({
      apiKey: "offline-synthetic-key",
      transportMode: "replay",
      fetch: async () =>
        Response.json(fixture.recordedResponse.body, { status: fixture.recordedResponse.status }),
    });
    const router = createTaskRouter({
      registry: fixture.registry,
      policy: fixture.policy,
      apiKey: "offline-synthetic-key",
      advisor,
    });
    const outcome = await router(fixture.request, new AbortController().signal);
    const expectedBinding = {
      delegationId: fixture.request.delegationId,
      taskId: fixture.request.taskId,
      inputDigest: digestJson(fixture.request),
      registryVersion: fixture.registry.registryVersion,
      registryDigest: digestJson(fixture.registry),
      policyVersion: fixture.policy.policyVersion,
      policyDigest: digestJson(fixture.policy),
    };
    results.push(
      RoutingRunResultSchema.parse({
        schemaVersion: "routing-run-v1",
        runId,
        caseId: benchmarkCase.caseId,
        caseVersion: benchmarkCase.caseVersion,
        outcome,
        checkStatus: matchesRoutingExpectation(outcome, benchmarkCase.expected, expectedBinding)
          ? "passed"
          : "failed",
        workerStatus: "not_run",
        qualityStatus: "not_run",
      }),
    );
    cases.push({
      caseId: benchmarkCase.caseId,
      caseVersion: benchmarkCase.caseVersion,
      fixtureId: fixture.fixtureId,
      fixtureVersion: fixture.fixtureVersion,
      fixtureDigest: digestJson(fixture),
      expectationDigest: digestJson({ expected: benchmarkCase.expected, expectedBinding }),
      expected: benchmarkCase.expected,
      expectedBinding,
    });
  }
  const manifest = RoutingRunManifestSchema.parse({
    schemaVersion: "routing-run-v1",
    mode: "offline_replay",
    stage: "routing-v1",
    runId,
    createdAt: new Date().toISOString(),
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    suiteDigest: digestJson(suite),
    verifierVersion: suite.verifierVersion,
    verifierDigest: await fingerprint([
      resolve(import.meta.dir, "verify-routing-outcome.ts"),
      resolve(import.meta.dir, "benchmark-contracts.ts"),
      resolve(import.meta.dir, "contracts.ts"),
      resolve(projectRoot, "src/benchmark/io.ts"),
    ]),
    implementation: {
      packageVersion: packageInfo.version,
      bunVersion: Bun.version,
      fingerprint: await fingerprint([
        resolve(import.meta.dir, "replay.ts"),
        resolve(import.meta.dir, "router.ts"),
        resolve(import.meta.dir, "advisor.ts"),
        resolve(import.meta.dir, "jev-advisor.ts"),
      ]),
    },
    cases,
  });
  const summary = RoutingRunSummarySchema.parse({
    runId,
    total: results.length,
    passed: results.filter(({ checkStatus }) => checkStatus === "passed").length,
    failed: results.filter(({ checkStatus }) => checkStatus === "failed").length,
    workerStatus: "not_run",
    qualityStatus: "not_run",
  });
  await publish(resolve(outputDirectory), manifest, results, summary);
  return summary;
}

async function publish(
  output: string,
  manifest: RoutingRunManifest,
  results: readonly RoutingRunResult[],
  summary: RoutingRunSummary,
): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".jevbrain-routing-"));
  let reserved = false;
  try {
    await writeFile(
      join(temporary, "results.jsonl"),
      `${results.map((result) => JSON.stringify(result)).join("\n")}\n`,
    );
    await writeFile(join(temporary, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(
      join(temporary, "summary.md"),
      `# Offline routing replay ${summary.runId}\n\n${summary.passed}/${summary.total} checks passed. No worker execution or routing-quality evaluation was run.\n`,
    );
    await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(output);
    reserved = true;
    for (const filename of ["results.jsonl", "summary.json", "summary.md", "manifest.json"]) {
      await rename(join(temporary, filename), join(output, filename));
    }
    await rm(temporary, { recursive: true });
  } catch (error: unknown) {
    await rm(temporary, { recursive: true, force: true });
    if (reserved) await rm(output, { recursive: true, force: true });
    throw error;
  }
}
