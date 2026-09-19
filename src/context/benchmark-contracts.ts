import { z } from "zod";
import { ContextSplitOutcomeSchema } from "./contracts.ts";

const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const ContextFixtureSchema = z
  .object({
    fixtureId: IdSchema,
    fixtureVersion: VersionSchema,
    request: z.unknown(),
    trustedPolicy: z.unknown(),
  })
  .strict();
export type ContextFixture = z.infer<typeof ContextFixtureSchema>;

export const ContextExpectationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      delegationId: IdSchema,
      policyVersion: VersionSchema,
      repositoryNamespace: IdSchema,
      briefingDigest: DigestSchema,
      admittedSources: z.array(
        z
          .object({
            sourceId: IdSchema,
            category: z.enum(["required", "shared", "evidence", "optional"]),
            contentDigest: DigestSchema,
          })
          .strict(),
      ),
      deniedCount: z.number().int().nonnegative(),
      unavailableCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("needs_context"),
      missingRequiredCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum(["invalid_request", "invalid_policy", "delegation_mismatch"]),
    })
    .strict(),
]);
export type ContextExpectation = z.infer<typeof ContextExpectationSchema>;

const ContextBenchmarkCaseSchema = z
  .object({
    caseId: IdSchema,
    caseVersion: VersionSchema,
    fixtureFile: z.string().min(1),
    expected: ContextExpectationSchema,
  })
  .strict();

export const ContextBenchmarkSuiteSchema = z
  .object({
    schemaVersion: z.literal("context-bench-v1"),
    suiteId: IdSchema,
    suiteVersion: VersionSchema,
    splitterVersion: z.literal("context-v1"),
    verifierVersion: z.literal("context-checks-v1"),
    cases: z.array(ContextBenchmarkCaseSchema).min(1),
  })
  .strict()
  .superRefine((suite, context) => {
    addDuplicateIssues(
      suite.cases.map(({ caseId }) => caseId),
      "caseId",
      context,
    );
  });

const ContextManifestCaseSchema = z
  .object({
    caseId: IdSchema,
    caseVersion: VersionSchema,
    fixtureId: IdSchema,
    fixtureVersion: VersionSchema,
    fixtureDigest: DigestSchema,
    expectationDigest: DigestSchema,
    expected: ContextExpectationSchema,
  })
  .strict();

export const ContextRunManifestSchema = z
  .object({
    schemaVersion: z.literal("context-run-v1"),
    mode: z.literal("replay"),
    stage: z.literal("context-v1"),
    runId: z.uuid(),
    createdAt: z.iso.datetime(),
    implementation: z
      .object({
        name: z.literal("jevbrain"),
        version: VersionSchema,
        bunVersion: z.string().min(1),
        fingerprint: DigestSchema,
      })
      .strict(),
    suiteId: IdSchema,
    suiteVersion: VersionSchema,
    suiteDigest: DigestSchema,
    splitterVersion: z.literal("context-v1"),
    splitterDigest: DigestSchema,
    verifierVersion: z.literal("context-checks-v1"),
    verifierDigest: DigestSchema,
    cases: z.array(ContextManifestCaseSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicateIssues(
      manifest.cases.map(({ caseId }) => caseId),
      "manifest caseId",
      context,
    );
  });
export type ContextRunManifest = z.infer<typeof ContextRunManifestSchema>;

export const ContextRunResultSchema = z
  .object({
    schemaVersion: z.literal("context-run-v1"),
    runId: z.uuid(),
    caseId: IdSchema,
    caseVersion: VersionSchema,
    outcome: ContextSplitOutcomeSchema,
    checkStatus: z.enum(["passed", "failed"]),
    workerStatus: z.literal("not_run"),
    qualityStatus: z.literal("not_run"),
    runtimeEnforcement: z.literal("not_run"),
  })
  .strict();
export type ContextRunResult = z.infer<typeof ContextRunResultSchema>;

export const ContextRunSummarySchema = z
  .object({
    runId: z.uuid(),
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    workerStatus: z.literal("not_run"),
    qualityStatus: z.literal("not_run"),
    runtimeEnforcement: z.literal("not_run"),
  })
  .strict();
export type ContextRunSummary = z.infer<typeof ContextRunSummarySchema>;

export const ContextRunComparisonSchema = z
  .object({
    schemaVersion: z.literal("context-run-v1"),
    baselineRunId: z.uuid(),
    candidateRunId: z.uuid(),
    compatible: z.boolean(),
    semanticEqual: z.boolean(),
    pairedCaseIds: z.array(IdSchema),
    changedCaseIds: z.array(IdSchema),
    incompatibleCaseIds: z.array(IdSchema),
    issues: z.array(z.string()),
  })
  .strict();
export type ContextRunComparison = z.infer<typeof ContextRunComparisonSchema>;

function addDuplicateIssues(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) context.addIssue({ code: "custom", message: `duplicate ${label}` });
    seen.add(value);
  }
}
