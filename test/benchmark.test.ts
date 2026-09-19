import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareRuns } from "../src/benchmark/compare.ts";
import { digestJson } from "../src/benchmark/io.ts";
import { replaySuite } from "../src/benchmark/replay.ts";
import { ReplayManifestSchema, ReplaySuiteSchema } from "../src/contracts.ts";

const suiteDirectory = resolve(import.meta.dir, "../bench/suites/contracts-v1");
const suiteFile = join(suiteDirectory, "suite.json");
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-test-"));
  temporaryRoots.push(root);
  return root;
}

async function copyRun(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("contract replay", () => {
  test("replays deterministically and preserves an existing output directory", async () => {
    const root = await temporaryRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    expect(await replaySuite(suiteFile, first)).toMatchObject({ total: 6, passed: 6, failed: 0 });
    expect(await replaySuite(suiteFile, second)).toMatchObject({ total: 6, passed: 6, failed: 0 });
    expect(await compareRuns(first, second)).toMatchObject({
      compatible: true,
      semanticEqual: true,
      changedCaseIds: [],
    });

    const occupied = join(root, "occupied");
    await mkdir(occupied);
    await writeFile(join(occupied, "sentinel"), "unchanged");
    await expect(replaySuite(suiteFile, occupied)).rejects.toThrow();
    expect(await readFile(join(occupied, "sentinel"), "utf8")).toBe("unchanged");

    const empty = join(root, "empty");
    await mkdir(empty);
    await expect(replaySuite(suiteFile, empty)).rejects.toThrow();
  });

  test("distinguishes an expected rejection from an unexpected rejection", async () => {
    const root = await temporaryRoot();
    const changedSuiteDirectory = join(root, "suite");
    await cp(suiteDirectory, changedSuiteDirectory, { recursive: true });
    const changedSuiteFile = join(changedSuiteDirectory, "suite.json");
    const suite = ReplaySuiteSchema.parse(
      JSON.parse(await readFile(changedSuiteFile, "utf8")) as unknown,
    );
    const changed = {
      ...suite,
      cases: suite.cases.map((item) =>
        item.caseId === "malformed-json"
          ? {
              ...item,
              expected: { status: "rejected" as const, reason: "delegation_mismatch" as const },
            }
          : item,
      ),
    };
    await writeFile(changedSuiteFile, `${JSON.stringify(changed, null, 2)}\n`);
    const summary = await replaySuite(changedSuiteFile, join(root, "run"));
    expect(summary).toMatchObject({ total: 6, passed: 5, failed: 1 });
  });
});

describe("strict run comparison", () => {
  test("reports incompatible case expectations and suite identity", async () => {
    const root = await temporaryRoot();
    const baseline = join(root, "baseline");
    const candidate = join(root, "candidate");
    await replaySuite(suiteFile, baseline);
    await copyRun(baseline, candidate);
    const manifestPath = join(candidate, "manifest.json");
    const manifest = ReplayManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    );
    const cases = manifest.cases.map((item) => {
      if (item.caseId !== "malformed-json") return item;
      const expected = { status: "rejected" as const, reason: "delegation_mismatch" as const };
      return { ...item, expected, expectationDigest: digestJson(expected) };
    });
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, suiteVersion: "2.0.0", cases }, null, 2)}\n`,
    );
    const comparison = await compareRuns(baseline, candidate);
    expect(comparison.compatible).toBe(false);
    expect(comparison.incompatibleCaseIds).toContain("malformed-json");
    expect(comparison.issues).toContain("suite identity differs");
  });

  test("rejects duplicate manifest declarations and incomplete publication", async () => {
    const root = await temporaryRoot();
    const baseline = join(root, "baseline");
    await replaySuite(suiteFile, baseline);

    const duplicate = join(root, "duplicate");
    await copyRun(baseline, duplicate);
    const duplicateManifestPath = join(duplicate, "manifest.json");
    const manifest = ReplayManifestSchema.parse(
      JSON.parse(await readFile(duplicateManifestPath, "utf8")) as unknown,
    );
    const firstCase = manifest.cases[0];
    if (firstCase === undefined) throw new Error("fixture manifest has no cases");
    await writeFile(
      duplicateManifestPath,
      `${JSON.stringify({ ...manifest, cases: [...manifest.cases, firstCase] }, null, 2)}\n`,
    );
    await expect(compareRuns(baseline, duplicate)).rejects.toThrow(/duplicate manifest caseId/);

    const incomplete = join(root, "incomplete");
    await copyRun(baseline, incomplete);
    await rm(join(incomplete, "manifest.json"));
    await expect(compareRuns(baseline, incomplete)).rejects.toThrow();
  });

  test("treats suite and verifier fingerprint changes as incompatible", async () => {
    const root = await temporaryRoot();
    const baseline = join(root, "baseline");
    const suiteChanged = join(root, "suite-changed");
    const verifierChanged = join(root, "verifier-changed");
    await replaySuite(suiteFile, baseline);
    await copyRun(baseline, suiteChanged);
    await copyRun(baseline, verifierChanged);
    const manifest = ReplayManifestSchema.parse(
      JSON.parse(await readFile(join(baseline, "manifest.json"), "utf8")) as unknown,
    );
    await writeFile(
      join(suiteChanged, "manifest.json"),
      `${JSON.stringify({ ...manifest, suiteDigest: `sha256:${"f".repeat(64)}` }, null, 2)}\n`,
    );
    await writeFile(
      join(verifierChanged, "manifest.json"),
      `${JSON.stringify({ ...manifest, verifierDigest: `sha256:${"e".repeat(64)}` }, null, 2)}\n`,
    );

    const suiteComparison = await compareRuns(baseline, suiteChanged);
    expect(suiteComparison).toMatchObject({ compatible: false, semanticEqual: false });
    expect(suiteComparison.issues).toContain("suite identity differs");
    const verifierComparison = await compareRuns(baseline, verifierChanged);
    expect(verifierComparison).toMatchObject({ compatible: false, semanticEqual: false });
    expect(verifierComparison.issues).toContain("verifier identity differs");
  });

  test.each(["missing", "duplicate", "foreign", "wrong-run", "schema-corrupt"])(
    "rejects %s result rows",
    async (kind) => {
      const root = await temporaryRoot();
      const baseline = join(root, "baseline");
      const corrupt = join(root, "corrupt");
      await replaySuite(suiteFile, baseline);
      await copyRun(baseline, corrupt);
      const resultsPath = join(corrupt, "results.jsonl");
      const lines = (await readFile(resultsPath, "utf8")).trim().split("\n");
      const first = JSON.parse(lines[0] ?? "null") as unknown;
      if (kind === "missing") lines.shift();
      if (kind === "duplicate") lines.push(lines[0] ?? "");
      if (kind === "foreign" && typeof first === "object" && first !== null)
        lines[0] = JSON.stringify({ ...first, caseId: "foreign-case" });
      if (kind === "wrong-run" && typeof first === "object" && first !== null)
        lines[0] = JSON.stringify({ ...first, runId: crypto.randomUUID() });
      if (kind === "schema-corrupt") lines[0] = JSON.stringify({ schemaVersion: "unknown" });
      await writeFile(resultsPath, `${lines.join("\n")}\n`);
      await expect(compareRuns(baseline, corrupt)).rejects.toThrow();
    },
  );
});
