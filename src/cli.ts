import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Command } from "commander";
import pc from "picocolors";
import { z } from "zod";
import { compareRuns } from "./benchmark/compare.ts";
import { replaySuite } from "./benchmark/replay.ts";
import { compareContextRuns } from "./context/compare.ts";
import { type ContextCliError, ContextCliErrorSchema } from "./context/contracts.ts";
import { replayContextSuite } from "./context/replay.ts";
import { splitContext } from "./context/split-context.ts";
import { compareEvaluations } from "./eval/compare.ts";
import { EvalAxisSchema } from "./eval/contracts.ts";
import { runEvaluation } from "./eval/run.ts";
import { compareRoutingRuns } from "./route/compare.ts";
import {
  RoutingErrorSchema,
  TaskRouteInputSchema,
  type TaskRouteResult,
} from "./route/contracts.ts";
import { createRoutingMcpServer } from "./route/mcp-server.ts";
import { replayRoutingSuite } from "./route/replay.ts";
import { loadTaskRouter } from "./route/startup.ts";

const ReplayOptionsSchema = z
  .object({ suite: z.string().min(1), out: z.string().min(1), json: z.boolean() })
  .strict();
const CompareOptionsSchema = z
  .object({ baseline: z.string().min(1), candidate: z.string().min(1), json: z.boolean() })
  .strict();
const ContextSplitOptionsSchema = z
  .object({ request: z.string().min(1), policy: z.string().min(1), json: z.boolean() })
  .strict();
const ContextReplayOptionsSchema = ReplayOptionsSchema;
const ContextCompareOptionsSchema = CompareOptionsSchema;
const RouteOptionsSchema = z
  .object({
    request: z.string().min(1),
    registry: z.string().min(1),
    policy: z.string().min(1),
    json: z.boolean(),
  })
  .strict();
const ServerOptionsSchema = z
  .object({ registry: z.string().min(1), policy: z.string().min(1) })
  .strict();
const EvalOptionsSchema = z
  .object({
    suite: z.string().min(1),
    config: z.string().min(1),
    out: z.string().min(1),
    live: z.boolean(),
    json: z.boolean(),
  })
  .strict();
const EvalCompareOptionsSchema = z
  .object({
    baseline: z.string().min(1),
    candidate: z.string().min(1),
    axes: z.string(),
    json: z.boolean(),
  })
  .strict();
const PackageSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });
const packageMetadata = PackageSchema.parse(
  (await Bun.file(new URL("../package.json", import.meta.url)).json()) as unknown,
);

const program = new Command();
program
  .name("jevbrain")
  .description("Jev-backed sub-agent routing CLI and benchmark tools.")
  .version(packageMetadata.version, "-v, --version");

program
  .command("route")
  .description("Select an eligible registered profile for an approved delegation.")
  .requiredOption("--request <file>", "host-approved routing request JSON")
  .requiredOption("--registry <file>", "trusted profile registry JSON")
  .requiredOption("--policy <file>", "trusted routing policy JSON")
  .option("--json", "print machine-readable JSON", false)
  .action(async (rawOptions: unknown) => {
    const options = RouteOptionsSchema.parse(rawOptions);
    const request = await readCliInput(options.request, "request_input_unreadable");
    if (!request.success) {
      process.stdout.write(
        `${JSON.stringify({ status: "error", reason: "request_input_unreadable" })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const router = await loadRouterForCli(options.registry, options.policy);
    if (router === undefined) return;
    const parsedRequest = TaskRouteInputSchema.safeParse(request.value);
    if (!parsedRequest.success) {
      writeRoutingCliError("invalid_routing_request", options.json);
      return;
    }
    let result: TaskRouteResult;
    try {
      result = await router(parsedRequest.data, new AbortController().signal);
    } catch {
      writeRoutingCliError("routing_failed", options.json);
      return;
    }
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`${pc.cyan(result.status)}\n`);
    if (result.status !== "selected") process.exitCode = 1;
  });

program
  .command("server")
  .description("Serve the task_route tool over MCP STDIO.")
  .requiredOption("--registry <file>", "trusted profile registry JSON")
  .requiredOption("--policy <file>", "trusted routing policy JSON")
  .action(async (rawOptions: unknown) => {
    const options = ServerOptionsSchema.parse(rawOptions);
    const router = await loadRouterForCli(options.registry, options.policy);
    if (router === undefined) return;
    serveStdio(() => createRoutingMcpServer(router), {
      onerror(error) {
        void error;
        process.stderr.write("jevbrain MCP transport error\n");
      },
    });
  });

const context = program
  .command("context")
  .description("Build context from a host-approved request and trusted host policy.");
context
  .command("split")
  .description(
    "Split host-supplied context without reading source files or enforcing runtime access.",
  )
  .requiredOption("--request <file>", "untrusted request JSON file")
  .requiredOption("--policy <file>", "trusted host policy and catalog JSON file")
  .option("--json", "print the complete machine-readable outcome", false)
  .action(async (rawOptions: unknown) => {
    const options = ContextSplitOptionsSchema.parse(rawOptions);
    const request = await readCliInput(options.request, "request_input_unreadable");
    if (!request.success) {
      writeContextCliResult(request.error, options.json);
      process.exitCode = 1;
      return;
    }
    const policy = await readCliInput(options.policy, "policy_input_unreadable");
    if (!policy.success) {
      writeContextCliResult(policy.error, options.json);
      process.exitCode = 1;
      return;
    }
    const outcome = splitContext(request.value, policy.value);
    writeContextCliResult(outcome, options.json);
    if (outcome.status !== "ready") process.exitCode = 1;
  });

const bench = program.command("bench").description("Run offline contract benchmark tools.");
bench
  .command("eval")
  .description("Run the bounded routing-eval-v1 pilot with rules, replay, or explicit live mode.")
  .requiredOption("--suite <file>", "path to the frozen evaluation suite JSON")
  .requiredOption("--config <file>", "path to the frozen evaluation run config JSON")
  .requiredOption("--out <directory>", "new immutable run directory")
  .option("--live", "permit the config to use bounded provider egress", false)
  .option("--json", "print machine-readable JSON", false)
  .action(async (rawOptions: unknown) => {
    const parsedOptions = EvalOptionsSchema.safeParse(rawOptions);
    if (!parsedOptions.success) {
      writeEvalCliError("invalid_eval_options", false);
      return;
    }
    const options = parsedOptions.data;
    try {
      const summary = await runEvaluation({
        suiteFile: options.suite,
        configFile: options.config,
        outputDirectory: options.out,
        allowLive: options.live,
        ...(process.env.TYPESAFE_API_KEY === undefined
          ? {}
          : { apiKey: process.env.TYPESAFE_API_KEY }),
        signal: new AbortController().signal,
      });
      if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
      else {
        const label = summary.complete ? pc.green("complete") : pc.yellow("incomplete");
        process.stdout.write(
          `${label}: ${summary.total.accepted}/${summary.total.planned} accepted; ${summary.total.notRun} not run\n`,
        );
      }
      if (!summary.complete || summary.total.operationalErrors > 0) process.exitCode = 1;
    } catch {
      writeEvalCliError("evaluation_failed", options.json);
    }
  });

bench
  .command("eval-compare")
  .description("Compare two finalized routing-eval-v1 runs across declared axes.")
  .requiredOption("--baseline <directory>", "baseline evaluation run directory")
  .requiredOption("--candidate <directory>", "candidate evaluation run directory")
  .option("--axes <csv>", "comma-separated controlled difference axes", "")
  .option("--json", "print machine-readable JSON", false)
  .action(async (rawOptions: unknown) => {
    const parsedOptions = EvalCompareOptionsSchema.safeParse(rawOptions);
    if (!parsedOptions.success) {
      writeEvalCliError("invalid_eval_compare_options", false);
      return;
    }
    const options = parsedOptions.data;
    const rawAxes = options.axes === "" ? [] : options.axes.split(",");
    const parsedAxes = z.array(EvalAxisSchema).safeParse(rawAxes);
    if (!parsedAxes.success) {
      writeEvalCliError("invalid_eval_axes", options.json);
      return;
    }
    try {
      const comparison = await compareEvaluations(
        options.baseline,
        options.candidate,
        parsedAxes.data,
      );
      if (options.json) process.stdout.write(`${JSON.stringify(comparison)}\n`);
      else {
        const label = comparison.compatible ? pc.green("compatible") : pc.yellow("incompatible");
        process.stdout.write(
          `${label}: ${comparison.pairedRows} paired; accepted delta ${comparison.deltas.accepted}\n`,
        );
      }
      if (!comparison.compatible || !comparison.complete) process.exitCode = 1;
    } catch {
      writeEvalCliError("evaluation_compare_failed", options.json);
    }
  });

bench
  .command("routing-replay")
  .description("Replay routing-v1 through the real router and an offline SDK transport.")
  .requiredOption("--suite <file>", "path to a routing benchmark suite JSON file")
  .requiredOption("--out <directory>", "new immutable run directory")
  .option("--json", "print machine-readable JSON", false)
  .action(async (rawOptions: unknown) => {
    const options = ReplayOptionsSchema.parse(rawOptions);
    const summary = await replayRoutingSuite(options.suite, options.out);
    if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    else
      process.stdout.write(
        `${pc.green(`${summary.passed}/${summary.total} routing checks passed`)}; run ${summary.runId}\n`,
      );
    if (summary.failed > 0) process.exitCode = 1;
  });

bench
  .command("routing-compare")
  .description("Compare two complete routing-v1 replay runs.")
  .requiredOption("--baseline <directory>", "baseline routing run directory")
  .requiredOption("--candidate <directory>", "candidate routing run directory")
  .option("--json", "print machine-readable JSON", false)
  .action(async (rawOptions: unknown) => {
    const options = CompareOptionsSchema.parse(rawOptions);
    const comparison = await compareRoutingRuns(options.baseline, options.candidate);
    if (options.json) process.stdout.write(`${JSON.stringify(comparison)}\n`);
    else
      process.stdout.write(
        `${comparison.semanticEqual ? pc.green("semantically equal") : pc.yellow("differences found")}: ${comparison.pairedCaseIds.length} paired\n`,
      );
    if (!comparison.compatible) process.exitCode = 1;
  });

bench
  .command("replay")
  .description("Replay a versioned synthetic response suite without provider or worker calls.")
  .requiredOption("--suite <file>", "path to a replay suite JSON file")
  .requiredOption("--out <directory>", "new immutable run directory")
  .option("--json", "print machine-readable JSON", false)
  .action(async (rawOptions: unknown) => {
    const options = ReplayOptionsSchema.parse(rawOptions);
    const summary = await replaySuite(options.suite, options.out);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      process.stdout.write(
        `${pc.green(`${summary.passed}/${summary.total} contract checks passed`)}; run ${summary.runId}\n`,
      );
    }
    if (summary.failed > 0) process.exitCode = 1;
  });

bench
  .command("context-replay")
  .description("Replay a versioned context-v1 suite through the real context splitter.")
  .requiredOption("--suite <file>", "path to a context benchmark suite JSON file")
  .requiredOption("--out <directory>", "new immutable run directory")
  .option("--json", "print machine-readable JSON", false)
  .action(async (rawOptions: unknown) => {
    const options = ContextReplayOptionsSchema.parse(rawOptions);
    const summary = await replayContextSuite(options.suite, options.out);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else {
      process.stdout.write(
        `${pc.green(`${summary.passed}/${summary.total} context checks passed`)}; run ${summary.runId}\n`,
      );
    }
    if (summary.failed > 0) process.exitCode = 1;
  });

bench
  .command("context-compare")
  .description("Compare two complete context-v1 replay runs.")
  .requiredOption("--baseline <directory>", "baseline context run directory")
  .requiredOption("--candidate <directory>", "candidate context run directory")
  .option("--json", "print machine-readable JSON", false)
  .action(async (rawOptions: unknown) => {
    const options = ContextCompareOptionsSchema.parse(rawOptions);
    const comparison = await compareContextRuns(options.baseline, options.candidate);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(comparison)}\n`);
    } else {
      const label = comparison.semanticEqual
        ? pc.green("semantically equal")
        : pc.yellow("differences found");
      process.stdout.write(
        `${label}: ${comparison.pairedCaseIds.length} paired, ${comparison.changedCaseIds.length} changed, ${comparison.incompatibleCaseIds.length} incompatible\n`,
      );
    }
    if (!comparison.compatible) process.exitCode = 1;
  });

bench
  .command("compare")
  .description("Compare two complete replay run directories.")
  .requiredOption("--baseline <directory>", "baseline run directory")
  .requiredOption("--candidate <directory>", "candidate run directory")
  .option("--json", "print machine-readable JSON", false)
  .action(async (rawOptions: unknown) => {
    const options = CompareOptionsSchema.parse(rawOptions);
    const comparison = await compareRuns(options.baseline, options.candidate);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(comparison)}\n`);
    } else {
      const label = comparison.semanticEqual
        ? pc.green("semantically equal")
        : pc.yellow("differences found");
      process.stdout.write(
        `${label}: ${comparison.pairedCaseIds.length} paired, ${comparison.changedCaseIds.length} changed, ${comparison.incompatibleCaseIds.length} incompatible\n`,
      );
    }
    if (!comparison.compatible) process.exitCode = 1;
  });

await program.parseAsync(process.argv);

function writeEvalCliError(reason: string, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify({ status: "error", reason })}\n`);
  else process.stderr.write(`${pc.red("error")}: ${reason}\n`);
  process.exitCode = 1;
}

type CliInputResult =
  | { success: true; value: unknown }
  | { success: false; error: ContextCliError };

async function readCliInput(
  path: string,
  reason: ContextCliError["reason"],
): Promise<CliInputResult> {
  try {
    return { success: true, value: JSON.parse(await Bun.file(path).text()) as unknown };
  } catch {
    return { success: false, error: ContextCliErrorSchema.parse({ status: "error", reason }) };
  }
}

function writeContextCliResult(result: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (typeof result === "object" && result !== null && "status" in result) {
    process.stdout.write(`${pc.cyan(String(result.status))}\n`);
  }
}

async function loadRouterForCli(registry: string, policy: string) {
  try {
    return await loadTaskRouter(registry, policy, process.env.TYPESAFE_API_KEY);
  } catch {
    process.stderr.write("jevbrain routing startup configuration is invalid\n");
    process.exitCode = 1;
    return undefined;
  }
}

function writeRoutingCliError(
  reason: "invalid_routing_request" | "routing_failed",
  json: boolean,
): void {
  const error = RoutingErrorSchema.parse({ status: "error", reason });
  if (json) process.stdout.write(`${JSON.stringify(error)}\n`);
  else process.stderr.write("jevbrain routing request is invalid\n");
  process.exitCode = 1;
}
