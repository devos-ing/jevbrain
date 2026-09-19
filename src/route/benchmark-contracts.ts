import { z } from "zod";
import {
  RoutingPolicySchema,
  RoutingRegistrySchema,
  TaskRouteInputSchema,
  TaskRouteResultSchema,
} from "./contracts.ts";

const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const RoutingFixtureSchema = z
  .object({
    fixtureId: IdSchema,
    fixtureVersion: VersionSchema,
    request: TaskRouteInputSchema,
    registry: RoutingRegistrySchema,
    policy: RoutingPolicySchema,
    recordedResponse: z
      .object({ status: z.number().int().min(100).max(599), body: z.unknown() })
      .strict(),
  })
  .strict();

export const RoutingExpectationSchema = z
  .object({
    status: z.enum(["selected", "abstained", "needs_context", "no_eligible_target", "cancelled"]),
    reason: z.string().min(1).optional(),
    profile: z
      .object({
        profileId: IdSchema,
        profileVersion: VersionSchema,
        runtime: z.enum(["codex-cli", "claude-code"]),
        model: z.string().min(1),
      })
      .strict()
      .optional(),
    attempts: z.number().int().min(0).max(1),
    transportMode: z.enum(["replay", "disabled"]),
    provider: z
      .object({
        model: z.literal("jev-1.13.0"),
        usage: z
          .object({
            inputTokens: z.number().int().nonnegative(),
            outputTokens: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const RoutingBenchmarkSuiteSchema = z
  .object({
    suiteId: IdSchema,
    suiteVersion: VersionSchema,
    verifierVersion: VersionSchema,
    cases: z
      .array(
        z
          .object({
            caseId: IdSchema,
            caseVersion: VersionSchema,
            fixtureFile: z.string().min(1),
            expected: RoutingExpectationSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((suite, context) => {
    const seen = new Set<string>();
    for (const item of suite.cases) {
      if (seen.has(item.caseId)) context.addIssue({ code: "custom", message: "duplicate case ID" });
      seen.add(item.caseId);
    }
  });

const ManifestCaseSchema = z
  .object({
    caseId: IdSchema,
    caseVersion: VersionSchema,
    fixtureId: IdSchema,
    fixtureVersion: VersionSchema,
    fixtureDigest: DigestSchema,
    expectationDigest: DigestSchema,
    expected: RoutingExpectationSchema,
    expectedBinding: z
      .object({
        delegationId: IdSchema,
        taskId: IdSchema,
        inputDigest: DigestSchema,
        registryVersion: VersionSchema,
        registryDigest: DigestSchema,
        policyVersion: VersionSchema,
        policyDigest: DigestSchema,
      })
      .strict(),
  })
  .strict();

export const RoutingRunManifestSchema = z
  .object({
    schemaVersion: z.literal("routing-run-v1"),
    mode: z.literal("offline_replay"),
    stage: z.literal("routing-v1"),
    runId: z.string().uuid(),
    createdAt: z.string().datetime(),
    suiteId: IdSchema,
    suiteVersion: VersionSchema,
    suiteDigest: DigestSchema,
    verifierVersion: VersionSchema,
    verifierDigest: DigestSchema,
    implementation: z
      .object({
        packageVersion: VersionSchema,
        bunVersion: z.string().min(1),
        fingerprint: DigestSchema,
      })
      .strict(),
    cases: z.array(ManifestCaseSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const item of manifest.cases) {
      if (seen.has(item.caseId))
        context.addIssue({ code: "custom", message: "duplicate manifest case ID" });
      seen.add(item.caseId);
    }
  });
export type RoutingRunManifest = z.infer<typeof RoutingRunManifestSchema>;

export const RoutingRunResultSchema = z
  .object({
    schemaVersion: z.literal("routing-run-v1"),
    runId: z.string().uuid(),
    caseId: IdSchema,
    caseVersion: VersionSchema,
    outcome: TaskRouteResultSchema,
    checkStatus: z.enum(["passed", "failed"]),
    workerStatus: z.literal("not_run"),
    qualityStatus: z.literal("not_run"),
  })
  .strict();
export type RoutingRunResult = z.infer<typeof RoutingRunResultSchema>;

export const RoutingRunSummarySchema = z
  .object({
    runId: z.string().uuid(),
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    workerStatus: z.literal("not_run"),
    qualityStatus: z.literal("not_run"),
  })
  .strict();
export type RoutingRunSummary = z.infer<typeof RoutingRunSummarySchema>;

export const RoutingRunComparisonSchema = z
  .object({
    schemaVersion: z.literal("routing-run-v1"),
    baselineRunId: z.string().uuid(),
    candidateRunId: z.string().uuid(),
    compatible: z.boolean(),
    semanticEqual: z.boolean(),
    pairedCaseIds: z.array(IdSchema),
    changedCaseIds: z.array(IdSchema),
    incompatibleCaseIds: z.array(IdSchema),
    issues: z.array(z.string()),
  })
  .strict();
export type RoutingRunComparison = z.infer<typeof RoutingRunComparisonSchema>;
