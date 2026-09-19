import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

const PackageVerificationResultSchema = z
  .object({
    status: z.literal("passed"),
    packageName: z.literal("jevbrain"),
    packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    replayChecks: z.number().int().positive(),
    evalCases: z.literal(12),
    evalComparison: z.literal(true),
    mcpTools: z.tuple([z.literal("task_route")]),
    mcpOutcome: z.literal("provider_disabled"),
  })
  .strict();

const PackageMetadataSchema = z
  .object({ name: z.literal("jevbrain"), version: z.string().regex(/^\d+\.\d+\.\d+$/) })
  .strip();
const ReplaySummarySchema = z
  .object({ total: z.number().int().positive(), passed: z.number().int().nonnegative() })
  .passthrough();
const EvalSummarySchema = z
  .object({ complete: z.literal(true), total: z.object({ planned: z.literal(12) }).passthrough() })
  .passthrough();
const EvalComparisonSchema = z
  .object({ compatible: z.literal(true), complete: z.literal(true), pairedRows: z.literal(12) })
  .passthrough();
const McpTextResultSchema = z
  .object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()).min(1),
  })
  .passthrough();
const DisabledOutcomeSchema = z
  .object({
    status: z.literal("abstained"),
    reason: z.literal("provider_disabled"),
    metadata: z
      .object({ attempts: z.literal(0), transportMode: z.literal("disabled") })
      .passthrough(),
  })
  .passthrough();

const projectRoot = resolve(import.meta.dir, "..");
const sourcePackage = PackageMetadataSchema.parse(
  JSON.parse(await Bun.file(join(projectRoot, "package.json")).text()) as unknown,
);
const temporaryRoot = await mkdtemp(join(tmpdir(), "jevbrain-package-verify-"));
const packageDirectory = join(temporaryRoot, "package");
const installDirectory = join(temporaryRoot, "consumer");
const tarball = join(packageDirectory, `${sourcePackage.name}-${sourcePackage.version}.tgz`);
const cleanEnvironment = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TMPDIR: temporaryRoot,
  BUN_INSTALL_CACHE_DIR: join(temporaryRoot, "bun-cache"),
  NO_COLOR: "1",
};

let client: Client | undefined;
try {
  await mkdir(packageDirectory);
  await mkdir(installDirectory);
  await run(
    [process.execPath, "pm", "pack", "--destination", packageDirectory, "--quiet"],
    projectRoot,
  );
  await writeFile(
    join(installDirectory, "package.json"),
    `${JSON.stringify({ name: "jevbrain-package-consumer", private: true }, null, 2)}\n`,
  );
  await run([process.execPath, "add", tarball], installDirectory);

  const installedRoot = join(installDirectory, "node_modules", "jevbrain");
  const installedBin = join(installDirectory, "node_modules", ".bin", "jevbrain");
  const packageMetadata = PackageMetadataSchema.parse(
    JSON.parse(await Bun.file(join(installedRoot, "package.json")).text()) as unknown,
  );
  const version = (await run([installedBin, "--version"], installDirectory)).stdout.trim();
  if (version !== packageMetadata.version) throw new Error("installed version output mismatch");
  const help = await run([installedBin, "--help"], installDirectory);
  if (!help.stdout.includes("server") || !help.stdout.includes("bench")) {
    throw new Error("installed help is missing expected commands");
  }

  const replayOutput = join(temporaryRoot, "routing-run");
  const replay = await run(
    [
      installedBin,
      "bench",
      "routing-replay",
      "--suite",
      join(installedRoot, "bench", "routing-v1", "suite.json"),
      "--out",
      replayOutput,
      "--json",
    ],
    installDirectory,
  );
  const replaySummary = ReplaySummarySchema.parse(JSON.parse(replay.stdout) as unknown);
  if (replaySummary.passed !== replaySummary.total) {
    throw new Error("installed routing replay failed checks");
  }

  const evalRoot = join(installedRoot, "bench", "eval", "pilot-v1");
  const rulesEvalOutput = join(temporaryRoot, "eval-rules");
  const replayEvalOutput = join(temporaryRoot, "eval-replay");
  const rulesEval = EvalSummarySchema.parse(
    JSON.parse(
      (
        await run(
          [
            installedBin,
            "bench",
            "eval",
            "--suite",
            join(evalRoot, "suite.json"),
            "--config",
            join(evalRoot, "rules.json"),
            "--out",
            rulesEvalOutput,
            "--json",
          ],
          installDirectory,
        )
      ).stdout,
    ) as unknown,
  );
  EvalSummarySchema.parse(
    JSON.parse(
      (
        await run(
          [
            installedBin,
            "bench",
            "eval",
            "--suite",
            join(evalRoot, "suite.json"),
            "--config",
            join(evalRoot, "jev-replay.json"),
            "--out",
            replayEvalOutput,
            "--json",
          ],
          installDirectory,
        )
      ).stdout,
    ) as unknown,
  );
  const evalComparison = EvalComparisonSchema.parse(
    JSON.parse(
      (
        await run(
          [
            installedBin,
            "bench",
            "eval-compare",
            "--baseline",
            rulesEvalOutput,
            "--candidate",
            replayEvalOutput,
            "--axes",
            "variant",
            "--json",
          ],
          installDirectory,
        )
      ).stdout,
    ) as unknown,
  );

  const registryFile = join(temporaryRoot, "registry.json");
  const policyFile = join(temporaryRoot, "policy.json");
  await writeFile(
    registryFile,
    JSON.stringify({
      registryVersion: "1.0.0",
      profiles: [
        {
          profileId: "clean-package-profile",
          profileVersion: "1.0.0",
          role: "Synthetic package verifier",
          description: "Default-off profile used only for local package verification.",
          runtime: "codex-cli",
          model: "synthetic-model",
          capabilities: ["typescript"],
          enabled: true,
          declaredAvailable: true,
        },
      ],
    }),
  );
  await writeFile(
    policyFile,
    JSON.stringify({
      policyVersion: "1.0.0",
      allowedProfileIds: ["clean-package-profile"],
      providerEnabled: false,
      egressEnabled: false,
      confidenceThreshold: 0.7,
      deadlineMs: 1_800_000,
      maxRequestBytes: 16_384,
      maxResponseBytes: 16_384,
    }),
  );
  const transport = new StdioClientTransport({
    command: installedBin,
    args: ["server", "--registry", registryFile, "--policy", policyFile],
    cwd: installDirectory,
    env: cleanEnvironment,
    stderr: "pipe",
  });
  client = new Client({ name: "jevbrain-package-verifier", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map(({ name }) => name);
  if (toolNames.length !== 1 || toolNames[0] !== "task_route") {
    throw new Error("installed MCP server exposes an unexpected tool set");
  }
  const call = McpTextResultSchema.parse(
    await client.callTool({
      name: "task_route",
      arguments: {
        delegationId: "clean-package-delegation",
        taskId: "clean-package-task",
        contextStatus: "ready",
        briefing: {
          objective: "Verify the installed package without provider egress.",
          acceptanceCriteria: ["Return a zero-attempt provider-disabled result."],
          constraints: ["Do not execute a worker."],
          decisions: [],
        },
        requiredCapabilities: ["typescript"],
      },
    }),
  );
  if (call.isError === true) throw new Error("installed MCP tool returned an error");
  const outcome = DisabledOutcomeSchema.parse(JSON.parse(call.content[0]?.text ?? "") as unknown);
  const result = PackageVerificationResultSchema.parse({
    status: "passed",
    packageName: packageMetadata.name,
    packageVersion: packageMetadata.version,
    replayChecks: replaySummary.passed,
    evalCases: rulesEval.total.planned,
    evalComparison: evalComparison.compatible,
    mcpTools: toolNames,
    mcpOutcome: outcome.reason,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  if (client !== undefined) await client.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function run(command: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    cwd,
    env: cleanEnvironment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`package verification command failed (${exitCode}): ${stderr}`);
  return { stdout, stderr };
}
