import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ContextBenchmarkSuiteSchema,
  ContextFixtureSchema,
  ContextRunManifestSchema,
  ContextRunResultSchema,
} from "../src/context/benchmark-contracts.ts";
import { compareContextRuns } from "../src/context/compare.ts";
import { replayContextSuite } from "../src/context/replay.ts";
import { splitContext } from "../src/context/split-context.ts";
import { matchesContextExpectation } from "../src/context/verify-context-outcome.ts";

const suiteFile = resolve(import.meta.dir, "../bench/suites/context-v1/suite.json");
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-context-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("context-v1 benchmark", () => {
  test("ready checks cover briefing, required categories, and admitted text provenance", async () => {
    const suite = ContextBenchmarkSuiteSchema.parse(
      JSON.parse(await readFile(suiteFile, "utf8")) as unknown,
    );
    const benchmarkCase = suite.cases.find(({ caseId }) => caseId === "ready-partition");
    if (benchmarkCase === undefined || benchmarkCase.expected.status !== "ready") {
      throw new Error("ready fixture expectation is missing");
    }
    const fixture = ContextFixtureSchema.parse(
      JSON.parse(
        await readFile(resolve(dirname(suiteFile), benchmarkCase.fixtureFile), "utf8"),
      ) as unknown,
    );
    const outcome = splitContext(fixture.request, fixture.trustedPolicy);
    expect(matchesContextExpectation(outcome, benchmarkCase.expected)).toBe(true);
    if (outcome.status !== "ready") throw new Error("expected ready outcome");
    const mandatoryIndex = outcome.manifest.entries.findIndex(
      ({ sourceId }) => sourceId === "mandatory-source",
    );
    if (mandatoryIndex < 0) throw new Error("mandatory fixture entry is missing");
    const downgraded = {
      ...outcome,
      manifest: {
        ...outcome.manifest,
        entries: outcome.manifest.entries.map((entry, index) =>
          index === mandatoryIndex ? { ...entry, category: "optional" as const } : entry,
        ),
      },
    };
    expect(matchesContextExpectation(downgraded, benchmarkCase.expected)).toBe(false);
    const corruptedText = {
      ...outcome,
      manifest: {
        ...outcome.manifest,
        entries: outcome.manifest.entries.map((entry, index) =>
          index === mandatoryIndex ? { ...entry, text: "corrupted text" } : entry,
        ),
      },
    };
    expect(matchesContextExpectation(corruptedText, benchmarkCase.expected)).toBe(false);
    const droppedConstraint = {
      ...outcome,
      manifest: {
        ...outcome.manifest,
        briefing: { ...outcome.manifest.briefing, constraints: [] },
      },
    };
    expect(matchesContextExpectation(droppedConstraint, benchmarkCase.expected)).toBe(false);
    const wrongBinding = {
      ...outcome,
      manifest: { ...outcome.manifest, delegationId: "delegation-wrong" },
      grant: { ...outcome.grant, delegationId: "delegation-wrong" },
    };
    expect(matchesContextExpectation(wrongBinding, benchmarkCase.expected)).toBe(false);
    const emptyGrant = {
      ...outcome,
      grant: { ...outcome.grant, admittedSources: [] },
    };
    expect(matchesContextExpectation(emptyGrant, benchmarkCase.expected)).toBe(false);
    const wrongByteCount = {
      ...outcome,
      manifest: {
        ...outcome.manifest,
        entries: outcome.manifest.entries.map((entry, index) =>
          index === mandatoryIndex ? { ...entry, utf8Bytes: entry.utf8Bytes + 1 } : entry,
        ),
      },
    };
    expect(matchesContextExpectation(wrongByteCount, benchmarkCase.expected)).toBe(false);
  });

  test("two real splitter runs compare equally without persisting excluded catalog data", async () => {
    const root = await temporaryRoot();
    const baseline = join(root, "baseline");
    const candidate = join(root, "candidate");
    expect(await replayContextSuite(suiteFile, baseline)).toMatchObject({ total: 3, passed: 3 });
    expect(await replayContextSuite(suiteFile, candidate)).toMatchObject({ total: 3, passed: 3 });
    expect(await compareContextRuns(baseline, candidate)).toMatchObject({
      compatible: true,
      semanticEqual: true,
      changedCaseIds: [],
      incompatibleCaseIds: [],
    });
    const serializedRun = `${await readFile(join(baseline, "manifest.json"), "utf8")}\n${await readFile(join(baseline, "results.jsonl"), "utf8")}`;
    for (const canary of [
      "PRIVATE_BENCHMARK_CANARY_TEXT",
      "private-canary-id",
      "BLOCKED_REQUIRED_CANARY_TEXT",
      "forbidden-required-canary",
      "pending-mandatory-canary",
    ]) {
      expect(serializedRun).not.toContain(canary);
    }
  });

  test("changed fixture and verifier identities are incompatible while splitter revisions remain comparable", async () => {
    const root = await temporaryRoot();
    const baseline = join(root, "baseline");
    await replayContextSuite(suiteFile, baseline);
    const manifest = ContextRunManifestSchema.parse(
      JSON.parse(await readFile(join(baseline, "manifest.json"), "utf8")) as unknown,
    );
    const firstCase = manifest.cases[0];
    if (firstCase === undefined) throw new Error("fixture manifest has no cases");

    const fixtureChanged = join(root, "fixture-changed");
    await cp(baseline, fixtureChanged, { recursive: true });
    await writeFile(
      join(fixtureChanged, "manifest.json"),
      `${JSON.stringify({ ...manifest, cases: [{ ...firstCase, fixtureDigest: `sha256:${"a".repeat(64)}` }, ...manifest.cases.slice(1)] }, null, 2)}\n`,
    );
    const fixtureComparison = await compareContextRuns(baseline, fixtureChanged);
    expect(fixtureComparison.compatible).toBe(false);
    expect(fixtureComparison.incompatibleCaseIds).toContain(firstCase.caseId);

    const verifierChanged = join(root, "verifier-changed");
    await cp(baseline, verifierChanged, { recursive: true });
    await writeFile(
      join(verifierChanged, "manifest.json"),
      `${JSON.stringify({ ...manifest, verifierDigest: `sha256:${"c".repeat(64)}` }, null, 2)}\n`,
    );
    const verifierComparison = await compareContextRuns(baseline, verifierChanged);
    expect(verifierComparison).toMatchObject({ compatible: false, semanticEqual: false });
    expect(verifierComparison.issues).toEqual(["verifier identity differs"]);

    const splitterChanged = join(root, "splitter-changed");
    await cp(baseline, splitterChanged, { recursive: true });
    await writeFile(
      join(splitterChanged, "manifest.json"),
      `${JSON.stringify({ ...manifest, splitterDigest: `sha256:${"b".repeat(64)}` }, null, 2)}\n`,
    );
    expect(await compareContextRuns(baseline, splitterChanged)).toMatchObject({
      compatible: true,
      semanticEqual: true,
    });
  });

  test.each(["missing", "duplicate", "foreign", "version", "schema"])(
    "rejects %s result rows",
    async (kind) => {
      const root = await temporaryRoot();
      const baseline = join(root, "baseline");
      const corrupt = join(root, "corrupt");
      await replayContextSuite(suiteFile, baseline);
      await cp(baseline, corrupt, { recursive: true });
      const resultsPath = join(corrupt, "results.jsonl");
      const lines = (await readFile(resultsPath, "utf8")).trim().split("\n");
      const first = ContextRunResultSchema.parse(JSON.parse(lines[0] ?? "null") as unknown);
      if (kind === "missing") lines.shift();
      if (kind === "duplicate") lines.push(lines[0] ?? "");
      if (kind === "foreign") lines[0] = JSON.stringify({ ...first, caseId: "foreign-case" });
      if (kind === "version") lines[0] = JSON.stringify({ ...first, caseVersion: "9.0.0" });
      if (kind === "schema") lines[0] = JSON.stringify({ schemaVersion: "unknown" });
      await writeFile(resultsPath, `${lines.join("\n")}\n`);
      await expect(compareContextRuns(baseline, corrupt)).rejects.toThrow();
    },
  );

  test("rejects duplicate declarations and missing completion manifest", async () => {
    const root = await temporaryRoot();
    const baseline = join(root, "baseline");
    await replayContextSuite(suiteFile, baseline);
    const manifest = ContextRunManifestSchema.parse(
      JSON.parse(await readFile(join(baseline, "manifest.json"), "utf8")) as unknown,
    );
    const firstCase = manifest.cases[0];
    if (firstCase === undefined) throw new Error("fixture manifest has no cases");
    const duplicate = join(root, "duplicate");
    await cp(baseline, duplicate, { recursive: true });
    await writeFile(
      join(duplicate, "manifest.json"),
      `${JSON.stringify({ ...manifest, cases: [...manifest.cases, firstCase] }, null, 2)}\n`,
    );
    await expect(compareContextRuns(baseline, duplicate)).rejects.toThrow(/duplicate manifest/);

    const incomplete = join(root, "incomplete");
    await cp(baseline, incomplete, { recursive: true });
    await rm(join(incomplete, "manifest.json"));
    await expect(compareContextRuns(baseline, incomplete)).rejects.toThrow();
  });
});
