import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ContextFixtureSchema,
  ContextRunComparisonSchema,
} from "../src/context/benchmark-contracts.ts";
import { ContextSplitOutcomeSchema } from "../src/context/contracts.ts";
import { ReplayComparisonSchema } from "../src/contracts.ts";
import { RoutingErrorSchema } from "../src/route/contracts.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runCli(
  arguments_: string[],
  entry = resolve(import.meta.dir, "../src/cli.ts"),
): Promise<string> {
  const child = Bun.spawn([process.execPath, entry, ...arguments_], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`CLI failed: ${stderr}`);
  return stdout;
}

async function runCliResult(
  arguments_: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...arguments_],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("CLI replays two runs and compares them", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-cli-test-"));
  roots.push(root);
  const suite = resolve(import.meta.dir, "../bench/suites/contracts-v1/suite.json");
  const baseline = join(root, "baseline");
  const candidate = join(root, "candidate");
  await runCli(["bench", "replay", "--suite", suite, "--out", baseline, "--json"]);
  await runCli(["bench", "replay", "--suite", suite, "--out", candidate, "--json"]);
  const comparison = ReplayComparisonSchema.parse(
    JSON.parse(
      await runCli([
        "bench",
        "compare",
        "--baseline",
        baseline,
        "--candidate",
        candidate,
        "--json",
      ]),
    ) as unknown,
  );
  expect(comparison).toMatchObject({ compatible: true, semanticEqual: true });
});

test("package launcher reports package version", async () => {
  const output = await runCli(["--version"], resolve(import.meta.dir, "../bin/jevbrain.mjs"));
  expect(output.trim()).toBe("0.0.1");
});

test("CLI splits host-prepared context and emits fixed non-leaking read errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-context-cli-"));
  roots.push(root);
  const fixture = ContextFixtureSchema.parse(
    JSON.parse(
      await readFile(
        resolve(import.meta.dir, "../bench/suites/context-v1/fixtures/ready-partition.json"),
        "utf8",
      ),
    ) as unknown,
  );
  const requestPath = join(root, "request.json");
  const policyPath = join(root, "policy.json");
  await writeFile(requestPath, JSON.stringify(fixture.request));
  await writeFile(policyPath, JSON.stringify(fixture.trustedPolicy));
  const success = await runCliResult([
    "context",
    "split",
    "--request",
    requestPath,
    "--policy",
    policyPath,
    "--json",
  ]);
  expect(success.exitCode).toBe(0);
  expect(ContextSplitOutcomeSchema.parse(JSON.parse(success.stdout) as unknown).status).toBe(
    "ready",
  );
  expect(success.stdout).not.toContain("PRIVATE_BENCHMARK_CANARY_TEXT");
  expect(success.stdout).not.toContain("private-canary-id");

  const privateMissingPath = join(root, "PRIVATE_PATH_CANARY.json");
  const failure = await runCliResult([
    "context",
    "split",
    "--request",
    privateMissingPath,
    "--policy",
    policyPath,
    "--json",
  ]);
  expect(failure.exitCode).toBe(1);
  expect(JSON.parse(failure.stdout)).toEqual({
    status: "error",
    reason: "request_input_unreadable",
  });
  expect(`${failure.stdout}${failure.stderr}`).not.toContain("PRIVATE_PATH_CANARY");
});

test("CLI context replay and compare use the real splitter", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-context-bench-cli-"));
  roots.push(root);
  const suite = resolve(import.meta.dir, "../bench/suites/context-v1/suite.json");
  const baseline = join(root, "baseline");
  const candidate = join(root, "candidate");
  await runCli(["bench", "context-replay", "--suite", suite, "--out", baseline, "--json"]);
  await runCli(["bench", "context-replay", "--suite", suite, "--out", candidate, "--json"]);
  const comparison = ContextRunComparisonSchema.parse(
    JSON.parse(
      await runCli([
        "bench",
        "context-compare",
        "--baseline",
        baseline,
        "--candidate",
        candidate,
        "--json",
      ]),
    ) as unknown,
  );
  expect(comparison).toMatchObject({ compatible: true, semanticEqual: true });
});

test("route CLI returns a fixed error without leaking invalid request fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-route-cli-"));
  roots.push(root);
  const requestPath = join(root, "request.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      delegationId: "delegation-1",
      taskId: "task-1",
      contextStatus: "ready",
      briefing: {
        objective: "Route a synthetic task.",
        acceptanceCriteria: ["Reject the extra field safely."],
        constraints: [],
        decisions: [],
      },
      requiredCapabilities: [],
      PRIVATE_SCHEMA_CANARY: "PRIVATE_SCHEMA_CANARY",
    }),
  );
  const result = await runCliResult([
    "route",
    "--request",
    requestPath,
    "--registry",
    resolve(import.meta.dir, "../examples/routing-registry.json"),
    "--policy",
    resolve(import.meta.dir, "../examples/routing-policy.json"),
    "--json",
  ]);
  expect(result.exitCode).toBe(1);
  expect(RoutingErrorSchema.parse(JSON.parse(result.stdout) as unknown)).toEqual({
    status: "error",
    reason: "invalid_routing_request",
  });
  expect(`${result.stdout}${result.stderr}`).not.toContain("PRIVATE_SCHEMA_CANARY");
});
