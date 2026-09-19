import { z } from "zod";

const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const TaskSpecSchema = z
  .object({
    taskId: IdSchema,
    objective: z.string().min(1),
    requiredCapabilities: z.array(IdSchema),
  })
  .strict();
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const AgentProfileSchema = z
  .object({
    profileId: IdSchema,
    runtime: z.enum(["codex-cli", "claude-code"]),
    modelId: IdSchema,
    enabled: z.boolean(),
    capabilities: z.array(IdSchema),
  })
  .strict();
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const SuppliedContextSchema = z
  .object({ contextId: IdSchema, digest: DigestSchema, summary: z.string().min(1) })
  .strict();

export const RoutingInputSchema = z
  .object({
    inputId: IdSchema,
    delegationId: IdSchema,
    task: TaskSpecSchema,
    suppliedContext: z.array(SuppliedContextSchema),
    candidateProfileIds: z.array(IdSchema).min(1),
  })
  .strict();
export type RoutingInput = z.infer<typeof RoutingInputSchema>;

export const RouteDecisionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("selected"),
      delegationId: IdSchema,
      profileId: IdSchema,
      reasonCode: IdSchema,
    })
    .strict(),
  z
    .object({ outcome: z.literal("abstained"), delegationId: IdSchema, reasonCode: IdSchema })
    .strict(),
  z.object({ outcome: z.literal("failed"), delegationId: IdSchema, reasonCode: IdSchema }).strict(),
]);
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

const RejectionReasonSchema = z.enum([
  "malformed_response",
  "delegation_mismatch",
  "unknown_profile",
  "profile_not_supplied",
]);

export const DecisionObservationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), decision: RouteDecisionSchema }).strict(),
  z.object({ status: z.literal("rejected"), reason: RejectionReasonSchema }).strict(),
]);
export type DecisionObservation = z.infer<typeof DecisionObservationSchema>;

export const ReplayRecordingSchema = z
  .object({
    recordingVersion: VersionSchema,
    caseId: IdSchema,
    inputId: IdSchema,
    responseText: z.string(),
  })
  .strict();
export type ReplayRecording = z.infer<typeof ReplayRecordingSchema>;

export const ReplayExpectationSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("accepted"), outcome: z.enum(["selected", "abstained", "failed"]) })
    .strict(),
  z.object({ status: z.literal("rejected"), reason: RejectionReasonSchema }).strict(),
]);
export type ReplayExpectation = z.infer<typeof ReplayExpectationSchema>;

export const ReplayCaseSchema = z
  .object({
    caseId: IdSchema,
    caseVersion: VersionSchema,
    input: RoutingInputSchema,
    profiles: z.array(AgentProfileSchema).min(1),
    recordingFile: z.string().min(1),
    expected: ReplayExpectationSchema,
  })
  .strict();
export type ReplayCase = z.infer<typeof ReplayCaseSchema>;

export const ReplaySuiteSchema = z
  .object({
    schemaVersion: z.literal("m0.1"),
    suiteId: IdSchema,
    suiteVersion: VersionSchema,
    verifierVersion: z.literal("contracts-v1"),
    cases: z.array(ReplayCaseSchema).min(1),
  })
  .strict()
  .superRefine((suite, context) => {
    const ids = new Set<string>();
    for (const replayCase of suite.cases) {
      if (ids.has(replayCase.caseId))
        context.addIssue({ code: "custom", message: `duplicate caseId: ${replayCase.caseId}` });
      ids.add(replayCase.caseId);
    }
  });
export type ReplaySuite = z.infer<typeof ReplaySuiteSchema>;

export const ManifestCaseSchema = z
  .object({
    caseId: IdSchema,
    caseVersion: VersionSchema,
    inputDigest: DigestSchema,
    profilesDigest: DigestSchema,
    recordingDigest: DigestSchema,
    expectationDigest: DigestSchema,
    input: RoutingInputSchema,
    profiles: z.array(AgentProfileSchema).min(1),
    recording: ReplayRecordingSchema,
    expected: ReplayExpectationSchema,
  })
  .strict();

export const ReplayManifestSchema = z
  .object({
    schemaVersion: z.literal("m0.1"),
    mode: z.literal("replay"),
    stage: z.literal("contracts-v1"),
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
    verifierVersion: z.literal("contracts-v1"),
    verifierDigest: DigestSchema,
    suiteDigest: DigestSchema,
    cases: z.array(ManifestCaseSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const item of manifest.cases) {
      if (ids.has(item.caseId)) {
        context.addIssue({ code: "custom", message: `duplicate manifest caseId: ${item.caseId}` });
      }
      ids.add(item.caseId);
    }
  });
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;

export const ReplayResultSchema = z
  .object({
    schemaVersion: z.literal("m0.1"),
    runId: z.uuid(),
    caseId: IdSchema,
    caseVersion: VersionSchema,
    observation: DecisionObservationSchema,
    checkStatus: z.enum(["passed", "failed"]),
    workerStatus: z.literal("not_run"),
    qualityStatus: z.literal("not_run"),
    providerUsage: z.literal("unavailable"),
  })
  .strict();
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export const ReplaySummarySchema = z
  .object({
    runId: z.uuid(),
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    workerStatus: z.literal("not_run"),
    qualityStatus: z.literal("not_run"),
    providerUsage: z.literal("unavailable"),
  })
  .strict();
export type ReplaySummary = z.infer<typeof ReplaySummarySchema>;

export const ReplayComparisonSchema = z
  .object({
    schemaVersion: z.literal("m0.1"),
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
export type ReplayComparison = z.infer<typeof ReplayComparisonSchema>;
