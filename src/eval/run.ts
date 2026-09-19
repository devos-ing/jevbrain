import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Fetch } from "@typesafe-ai/sdk";
import { z } from "zod";
import { digest, digestJson, readJson } from "../benchmark/io.ts";
import { createJevAdvisor, JEV_MODEL } from "../route/jev-advisor.ts";
import { createTaskRouter, findEligible } from "../route/router.ts";
import {
  type EvalManifest,
  EvalManifestSchema,
  type EvalRow,
  EvalRowSchema,
  type EvalRunConfig,
  EvalRunConfigSchema,
  type EvalSuite,
  EvalSuiteSchema,
  type EvalSummary,
  EvalVerdictSchema,
  NeutralObservationSchema,
} from "./contracts.ts";
import { routeByFirstEligible } from "./rules.ts";
import {
  evaluateObservation,
  fixtureDigest,
  neutralizeRouterResult,
  summarizeEval,
} from "./verify.ts";

const PackageSchema = z.object({
  name: z.literal("jevbrain"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
const SdkPackageSchema = z.object({ version: z.literal("0.6.0") });
const projectRoot = resolve(import.meta.dir, "../..");

export async function runEvaluation(options: {
  suiteFile: string;
  configFile: string;
  outputDirectory: string;
  allowLive: boolean;
  apiKey?: string;
  fetch?: Fetch;
  signal: AbortSignal;
}): Promise<EvalSummary> {
  const suite = EvalSuiteSchema.parse(await readJson(resolve(options.suiteFile)));
  const config = EvalRunConfigSchema.parse(await readJson(resolve(options.configFile)));
  if (config.mode === "live" && !options.allowLive)
    throw new Error("live evaluation requires --live");
  if (config.model !== JEV_MODEL) throw new Error("unsupported model override");
  if (config.promptVersion !== "production-v1") throw new Error("unsupported prompt override");
  const output = resolve(options.outputDirectory);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const runId = crypto.randomUUID();
  const plannedCases = suite.cases;
  const createdAt = new Date().toISOString();
  const frozenManifest = await createManifest(runId, suite, config, plannedCases, createdAt);
  await writeFile(
    join(output, "plan.json"),
    `${JSON.stringify({ schemaVersion: "routing-eval-plan-v1", runId, suite, config }, null, 2)}\n`,
  );
  await writeFile(join(output, "suite.json"), `${JSON.stringify(suite, null, 2)}\n`);
  await writeFile(join(output, "results.jsonl"), "");

  const runController = new AbortController();
  let stopReason: "deadline_exceeded" | "caller_cancelled" | undefined;
  const cancelFromCaller = () => {
    stopReason = "caller_cancelled";
    runController.abort();
  };
  const cancelFromDeadline = () => {
    stopReason = "deadline_exceeded";
    runController.abort();
  };
  options.signal.addEventListener("abort", cancelFromCaller, { once: true });
  process.once("SIGINT", cancelFromCaller);
  const timeout = setTimeout(cancelFromDeadline, config.totalDeadlineMs);
  if (options.signal.aborted) cancelFromCaller();
  const rows: EvalRow[] = [];
  let actualRequests = 0;
  try {
    for (const [caseIndex, benchmarkCase] of plannedCases.entries()) {
      if (runController.signal.aborted) {
        await saveRow(
          output,
          rows,
          notRunRow(runId, benchmarkCase, stopReason ?? "caller_cancelled"),
        );
        continue;
      }
      if (caseIndex >= config.maxCases) {
        await saveRow(output, rows, notRunRow(runId, benchmarkCase, "budget_exhausted"));
        continue;
      }
      if (
        config.variant === "jev:production-v1" &&
        actualRequests >= config.maxRequests &&
        requiresProvider(baselineInput(benchmarkCase), suite, config)
      ) {
        await saveRow(output, rows, notRunRow(runId, benchmarkCase, "budget_exhausted"));
        continue;
      }
      const requestsBefore = actualRequests;
      try {
        const observation =
          config.variant === "rules:first-eligible-v1"
            ? routeByFirstEligible(benchmarkCase.request, suite.registry, config.policy)
            : await routeWithJev({
                suite,
                config,
                benchmarkCase,
                ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                signal: runController.signal,
                countRequest: () => {
                  if (runController.signal.aborted || actualRequests >= config.maxRequests) {
                    throw new Error("request budget unavailable");
                  }
                  actualRequests += 1;
                },
              });
        const authoritativeObservation = {
          ...observation,
          attempts:
            config.variant === "rules:first-eligible-v1" ? 0 : actualRequests - requestsBefore,
        };
        const parsedObservation = NeutralObservationSchema.parse(authoritativeObservation);
        const verdict = evaluateObservation(parsedObservation, benchmarkCase);
        await saveRow(
          output,
          rows,
          EvalRowSchema.parse({
            schemaVersion: "routing-eval-row-v1",
            runId,
            caseId: benchmarkCase.caseId,
            caseVersion: benchmarkCase.caseVersion,
            repeat: 1,
            split: benchmarkCase.split,
            theme: benchmarkCase.theme,
            fixtureDigest: fixtureDigest(benchmarkCase),
            labelsDigest: digestJson(benchmarkCase.labels),
            executionStatus:
              parsedObservation.decision === "cancelled"
                ? "cancelled"
                : verdict.status === "error"
                  ? "failed"
                  : "completed",
            observation: parsedObservation,
            verdict,
          }),
        );
      } catch {
        await saveRow(output, rows, failedRow(runId, benchmarkCase));
      }
    }
    const summary = summarizeEval(runId, rows);
    await writeFile(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(join(output, "summary.md"), summaryMarkdown(summary, config));
    const manifest = EvalManifestSchema.parse({
      ...frozenManifest,
      completedAt: new Date().toISOString(),
    });
    await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return summary;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", cancelFromCaller);
    process.removeListener("SIGINT", cancelFromCaller);
  }
}

function baselineInput(benchmarkCase: EvalSuite["cases"][number]) {
  return benchmarkCase.request;
}

function requiresProvider(
  input: EvalSuite["cases"][number]["request"],
  suite: EvalSuite,
  config: EvalRunConfig,
): boolean {
  if (input.contextStatus !== "ready") return false;
  const known = new Set(suite.registry.profiles.map(({ profileId }) => profileId));
  if (input.candidateProfileIds?.some((profileId) => !known.has(profileId))) return false;
  return findEligible(input, suite.registry, config.policy).length > 0;
}

async function routeWithJev(options: {
  suite: EvalSuite;
  config: EvalRunConfig;
  benchmarkCase: EvalSuite["cases"][number];
  apiKey?: string;
  fetch?: Fetch;
  signal: AbortSignal;
  countRequest: () => void;
}) {
  const recorded = options.benchmarkCase.recordedResponse;
  const fetchImplementation =
    options.config.mode === "replay"
      ? async () => {
          options.countRequest();
          if (recorded === undefined) throw new Error("missing replay recording");
          return Response.json(recorded.body, { status: recorded.status });
        }
      : async (input: string, init?: RequestInit) => {
          options.countRequest();
          return (options.fetch ?? fetch)(input, init);
        };
  const apiKey = options.config.mode === "replay" ? "offline-synthetic-key" : options.apiKey;
  const advisor =
    apiKey === undefined || apiKey.length === 0
      ? undefined
      : createJevAdvisor({
          apiKey,
          transportMode: options.config.mode,
          fetch: fetchImplementation,
        });
  const router = createTaskRouter({
    registry: options.suite.registry,
    policy: options.config.policy,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(advisor === undefined ? {} : { advisor }),
  });
  return neutralizeRouterResult(await router(options.benchmarkCase.request, options.signal));
}

async function saveRow(output: string, rows: EvalRow[], row: EvalRow): Promise<void> {
  rows.push(row);
  await appendFile(join(output, "results.jsonl"), `${JSON.stringify(row)}\n`);
}

function notRunRow(
  runId: string,
  benchmarkCase: EvalSuite["cases"][number],
  reason: "budget_exhausted" | "deadline_exceeded" | "caller_cancelled",
): EvalRow {
  return EvalRowSchema.parse({
    schemaVersion: "routing-eval-row-v1",
    runId,
    caseId: benchmarkCase.caseId,
    caseVersion: benchmarkCase.caseVersion,
    repeat: 1,
    split: benchmarkCase.split,
    theme: benchmarkCase.theme,
    fixtureDigest: fixtureDigest(benchmarkCase),
    labelsDigest: digestJson(benchmarkCase.labels),
    executionStatus: "not_run",
    observation: null,
    verdict: EvalVerdictSchema.parse({
      status: "not_run",
      reason,
    }),
  });
}

function failedRow(runId: string, benchmarkCase: EvalSuite["cases"][number]): EvalRow {
  return EvalRowSchema.parse({
    schemaVersion: "routing-eval-row-v1",
    runId,
    caseId: benchmarkCase.caseId,
    caseVersion: benchmarkCase.caseVersion,
    repeat: 1,
    split: benchmarkCase.split,
    theme: benchmarkCase.theme,
    fixtureDigest: fixtureDigest(benchmarkCase),
    labelsDigest: digestJson(benchmarkCase.labels),
    executionStatus: "failed",
    observation: null,
    verdict: { status: "error", reason: "operational_error" },
  });
}

async function createManifest(
  runId: string,
  suite: EvalSuite,
  config: EvalRunConfig,
  plannedCases: EvalSuite["cases"],
  createdAt: string,
): Promise<EvalManifest> {
  const packageInfo = PackageSchema.parse(await readJson(join(projectRoot, "package.json")));
  const sdkEntry = Bun.resolveSync("@typesafe-ai/sdk", projectRoot);
  const sdkInfo = SdkPackageSchema.parse(
    await readJson(resolve(dirname(sdkEntry), "../package.json")),
  );
  const cases = plannedCases.map((benchmarkCase) => {
    const { recordedResponse, ...safeCase } = benchmarkCase;
    return {
      ...safeCase,
      fixtureDigest: fixtureDigest(benchmarkCase),
      recordingDigest: recordedResponse === undefined ? null : digestJson(recordedResponse),
    };
  });
  return EvalManifestSchema.parse({
    schemaVersion: "routing-eval-manifest-v1",
    stage: "routing-eval-v1",
    runId,
    createdAt,
    completedAt: createdAt,
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    suiteDigest: digestJson(suite),
    registry: suite.registry,
    registryDigest: digestJson(suite.registry),
    config,
    configDigest: digestJson(config),
    implementation: {
      packageVersion: packageInfo.version,
      bunVersion: Bun.version,
      sdkVersion: sdkInfo.version,
      lockDigest: digest(await readFile(join(projectRoot, "bun.lock"), "utf8")),
      runnerDigest: await sourceDigest(["src/eval/run.ts", "src/eval/rules.ts"]),
      routerDigest: await sourceDigest([
        "src/route/contracts.ts",
        "src/route/router.ts",
        "src/route/advisor.ts",
        "src/route/jev-advisor.ts",
      ]),
      promptDigest: await sourceDigest(["src/route/jev-advisor.ts"]),
    },
    verifierVersion: "1.0.0",
    verifierDigest: await sourceDigest([
      "src/eval/verify.ts",
      "src/eval/contracts.ts",
      "src/benchmark/io.ts",
    ]),
    cases,
  });
}

async function sourceDigest(paths: readonly string[]): Promise<`sha256:${string}`> {
  return digest(
    (await Promise.all(paths.map((path) => readFile(join(projectRoot, path), "utf8")))).join("\n"),
  );
}

function summaryMarkdown(summary: EvalSummary, config: EvalRunConfig): string {
  return `# Routing evaluation ${summary.runId}\n\nVariant: ${config.variant}\nMode: ${config.mode}\nComplete: ${summary.complete}\nAccepted: ${summary.total.accepted}/${summary.total.planned}\nOperational errors: ${summary.total.operationalErrors}\nNot run: ${summary.total.notRun}\n\nNo worker was executed. Rules make no provider request; replay usage is synthetic; live usage is provider-reported.\n`;
}
