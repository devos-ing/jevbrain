import { z } from "zod";
import {
  RoutingPolicySchema,
  RoutingRegistrySchema,
  TaskRouteInputSchema,
} from "../route/contracts.ts";

const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const SplitSchema = z.enum(["tuning", "heldout"]);
const ThemeSchema = z.enum([
  "local_edit",
  "crossfile_edit",
  "debug",
  "review",
  "exploration",
  "missing_context",
]);
export const EvalVariantSchema = z.enum(["rules:first-eligible-v1", "jev:production-v1"]);
export const EvalModeSchema = z.enum(["replay", "live"]);
export const EvalAxisSchema = z.enum([
  "variant",
  "policy",
  "execution",
  "implementation",
  "model",
  "prompt",
  "mode",
]);

export const EvalLabelsSchema = z
  .object({
    acceptableProfileIds: z.array(IdSchema),
    acceptableOutcomes: z
      .array(
        z.enum([
          "selected",
          "advisor_abstain",
          "confidence_abstain",
          "needs_context",
          "no_eligible_target",
        ]),
      )
      .min(1),
    rationale: z.string().min(1).max(600),
  })
  .strict()
  .superRefine((labels, context) => {
    if (new Set(labels.acceptableProfileIds).size !== labels.acceptableProfileIds.length) {
      context.addIssue({ code: "custom", message: "duplicate acceptable profile" });
    }
    if (new Set(labels.acceptableOutcomes).size !== labels.acceptableOutcomes.length) {
      context.addIssue({ code: "custom", message: "duplicate acceptable outcome" });
    }
  });

export const EvalCaseSchema = z
  .object({
    caseId: IdSchema,
    caseVersion: VersionSchema,
    split: SplitSchema,
    theme: ThemeSchema,
    request: TaskRouteInputSchema,
    labels: EvalLabelsSchema,
    recordedResponse: z
      .object({ status: z.number().int().min(100).max(599), body: z.unknown() })
      .strict()
      .optional(),
  })
  .strict();
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalSuiteSchema = z
  .object({
    schemaVersion: z.literal("routing-eval-v1"),
    suiteId: IdSchema,
    suiteVersion: VersionSchema,
    registry: RoutingRegistrySchema,
    cases: z.array(EvalCaseSchema).min(1),
  })
  .strict()
  .superRefine((suite, context) => {
    addDuplicateIssues(
      suite.cases.map(({ caseId }) => caseId),
      "case ID",
      context,
    );
    const registryIds = new Set(suite.registry.profiles.map(({ profileId }) => profileId));
    for (const item of suite.cases) {
      if (item.labels.acceptableProfileIds.some((profileId) => !registryIds.has(profileId))) {
        context.addIssue({ code: "custom", message: "label references unknown profile" });
      }
    }
  });
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

export const EvalRunConfigSchema = z
  .object({
    schemaVersion: z.literal("routing-eval-config-v1"),
    configId: IdSchema,
    configVersion: VersionSchema,
    variant: EvalVariantSchema,
    mode: EvalModeSchema,
    model: z.string().min(1).max(160),
    promptVersion: z.string().min(1).max(160),
    policy: RoutingPolicySchema,
    maxCases: z.number().int().min(1).max(12),
    repeats: z.literal(1),
    maxRequests: z.number().int().min(0).max(12),
    totalDeadlineMs: z.number().int().min(1_000).max(21_600_000),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.variant === "rules:first-eligible-v1" && config.mode !== "replay") {
      context.addIssue({ code: "custom", message: "rules variant is offline" });
    }
    if (config.variant === "jev:production-v1" && config.mode === "live") {
      if (!config.policy.providerEnabled || !config.policy.egressEnabled) {
        context.addIssue({ code: "custom", message: "live Jev requires provider and egress" });
      }
    }
    if (config.policy.deadlineMs > config.totalDeadlineMs) {
      context.addIssue({ code: "custom", message: "route deadline exceeds run deadline" });
    }
  });
export type EvalRunConfig = z.infer<typeof EvalRunConfigSchema>;

const ProviderObservationSchema = z
  .object({
    model: z.string().min(1),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const NeutralObservationSchema = z
  .object({
    decision: z.enum([
      "selected",
      "abstained",
      "needs_context",
      "no_eligible_target",
      "cancelled",
      "error",
    ]),
    selectedProfileId: IdSchema.optional(),
    reason: z.string().min(1).max(80),
    confidence: z.number().min(0).max(1).optional(),
    attempts: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
    transportMode: z.enum(["rules", "replay", "live", "disabled"]),
    provider: ProviderObservationSchema.optional(),
    binding: z
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
  .strict()
  .superRefine((observation, context) => {
    if ((observation.decision === "selected") !== (observation.selectedProfileId !== undefined)) {
      context.addIssue({ code: "custom", message: "selected profile shape mismatch" });
    }
  });
export type NeutralObservation = z.infer<typeof NeutralObservationSchema>;

export const EvalVerdictSchema = z
  .object({
    status: z.enum(["accepted", "rejected", "error", "not_run"]),
    reason: z.enum([
      "acceptable_selection",
      "wrong_selection",
      "intentional_abstain",
      "unexpected_abstain",
      "operational_error",
      "cancelled",
      "budget_exhausted",
      "deadline_exceeded",
      "caller_cancelled",
    ]),
  })
  .strict();
export type EvalVerdict = z.infer<typeof EvalVerdictSchema>;

export const EvalRowSchema = z
  .object({
    schemaVersion: z.literal("routing-eval-row-v1"),
    runId: z.string().uuid(),
    caseId: IdSchema,
    caseVersion: VersionSchema,
    repeat: z.literal(1),
    split: SplitSchema,
    theme: ThemeSchema,
    fixtureDigest: DigestSchema,
    labelsDigest: DigestSchema,
    executionStatus: z.enum(["completed", "failed", "cancelled", "not_run"]),
    observation: NeutralObservationSchema.nullable(),
    verdict: EvalVerdictSchema,
  })
  .strict();
export type EvalRow = z.infer<typeof EvalRowSchema>;

export const EvalCountsSchema = z
  .object({
    planned: z.number().int().nonnegative(),
    observed: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    wrongSelections: z.number().int().nonnegative(),
    intentionalAbstain: z.number().int().nonnegative(),
    operationalErrors: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    notRun: z.number().int().nonnegative(),
  })
  .strict();

const LatencySchema = z
  .object({
    observedCount: z.number().int().nonnegative(),
    medianMs: z.number().nonnegative().nullable(),
    minMs: z.number().int().nonnegative().nullable(),
    maxMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
const EvalSegmentSchema = EvalCountsSchema.extend({ latency: LatencySchema });

export const EvalSummarySchema = z
  .object({
    schemaVersion: z.literal("routing-eval-summary-v1"),
    runId: z.string().uuid(),
    complete: z.boolean(),
    total: EvalSegmentSchema,
    tuning: EvalSegmentSchema,
    heldout: EvalSegmentSchema,
    suitability: EvalSegmentSchema,
    readiness: EvalSegmentSchema,
    providerUsage: z
      .object({
        kind: z.enum(["unavailable", "synthetic", "reported"]),
        observedCount: z.number().int().nonnegative(),
        unavailableCount: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type EvalSummary = z.infer<typeof EvalSummarySchema>;

const ManifestCaseSchema = EvalCaseSchema.omit({ recordedResponse: true }).extend({
  fixtureDigest: DigestSchema,
  recordingDigest: DigestSchema.nullable(),
});

export const EvalManifestSchema = z
  .object({
    schemaVersion: z.literal("routing-eval-manifest-v1"),
    stage: z.literal("routing-eval-v1"),
    runId: z.string().uuid(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    suiteId: IdSchema,
    suiteVersion: VersionSchema,
    suiteDigest: DigestSchema,
    registry: RoutingRegistrySchema,
    registryDigest: DigestSchema,
    config: EvalRunConfigSchema,
    configDigest: DigestSchema,
    implementation: z
      .object({
        packageVersion: VersionSchema,
        bunVersion: z.string().min(1),
        sdkVersion: VersionSchema,
        lockDigest: DigestSchema,
        runnerDigest: DigestSchema,
        routerDigest: DigestSchema,
        promptDigest: DigestSchema,
      })
      .strict(),
    verifierVersion: VersionSchema,
    verifierDigest: DigestSchema,
    cases: z.array(ManifestCaseSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicateIssues(
      manifest.cases.map(({ caseId }) => caseId),
      "manifest case ID",
      context,
    );
  });
export type EvalManifest = z.infer<typeof EvalManifestSchema>;

export const EvalComparisonSchema = z
  .object({
    schemaVersion: z.literal("routing-eval-comparison-v1"),
    baselineRunId: z.string().uuid(),
    candidateRunId: z.string().uuid(),
    compatible: z.boolean(),
    complete: z.boolean(),
    allowedAxes: z.array(EvalAxisSchema),
    actualDifferences: z.array(
      z.object({ axis: EvalAxisSchema, baseline: z.string(), candidate: z.string() }).strict(),
    ),
    pairedRows: z.number().int().nonnegative(),
    decisionChanges: z.array(IdSchema),
    verdictChanges: z.array(IdSchema),
    baselineSummary: EvalSummarySchema,
    candidateSummary: EvalSummarySchema,
    deltas: z
      .object({
        accepted: z.number().int(),
        operationalErrors: z.number().int(),
        medianLatencyMs: z.number().nullable(),
        observedInputTokens: z.number().int().nullable(),
        observedOutputTokens: z.number().int().nullable(),
      })
      .strict(),
    issues: z.array(z.string()),
  })
  .strict();
export type EvalComparison = z.infer<typeof EvalComparisonSchema>;

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
