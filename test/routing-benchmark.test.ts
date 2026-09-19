import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readJson } from "../src/benchmark/io.ts";
import { RoutingRunManifestSchema } from "../src/route/benchmark-contracts.ts";
import { compareRoutingRuns } from "../src/route/compare.ts";
import { replayRoutingSuite } from "../src/route/replay.ts";

const suite = resolve(import.meta.dir, "../bench/routing-v1/suite.json");

test("routing replay is deterministic and implementation provenance remains comparable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevbrain-routing-bench-"));
  const left = join(directory, "left");
  const right = join(directory, "right");
  try {
    const leftSummary = await replayRoutingSuite(suite, left);
    const rightSummary = await replayRoutingSuite(suite, right);
    expect(leftSummary.passed).toBe(4);
    expect(rightSummary.passed).toBe(4);
    const manifestPath = join(right, "manifest.json");
    const manifest = RoutingRunManifestSchema.parse(await readJson(manifestPath));
    const changedProvenance = RoutingRunManifestSchema.parse({
      ...manifest,
      implementation: { ...manifest.implementation, fingerprint: `sha256:${"f".repeat(64)}` },
    });
    await writeFile(manifestPath, `${JSON.stringify(changedProvenance, null, 2)}\n`);
    const comparison = await compareRoutingRuns(left, right);
    expect(comparison.compatible).toBe(true);
    expect(comparison.semanticEqual).toBe(true);
    expect(comparison.pairedCaseIds).toHaveLength(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("routing comparison rejects incomplete publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevbrain-routing-incomplete-"));
  const left = join(directory, "left");
  const right = join(directory, "right");
  try {
    await replayRoutingSuite(suite, left);
    await replayRoutingSuite(suite, right);
    await unlink(join(right, "manifest.json"));
    await expect(compareRoutingRuns(left, right)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("routing replay never overwrites a pre-existing empty directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevbrain-routing-immutable-"));
  const output = join(directory, "existing");
  try {
    await mkdir(output);
    await expect(replayRoutingSuite(suite, output)).rejects.toThrow();
    expect(await readdir(output)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
