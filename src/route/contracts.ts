import { z } from "zod";

const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]*$/)
  .max(96);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const BriefTextSchema = z.string().min(1).max(2_000);
const BriefListSchema = z.array(BriefTextSchema).max(16);

export const RoutingBriefSchema = z
  .object({
    objective: BriefTextSchema,
    acceptanceCriteria: BriefListSchema.min(1),
    constraints: BriefListSchema,
    decisions: BriefListSchema,
  })
  .strict();

export const TaskRouteInputSchema = z
  .object({
    delegationId: IdSchema,
    taskId: IdSchema,
    contextStatus: z.enum(["ready", "needs_context"]),
    briefing: RoutingBriefSchema,
    requiredCapabilities: z.array(IdSchema).max(32),
    candidateProfileIds: z.array(IdSchema).max(64).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    addDuplicateIssues(input.requiredCapabilities, "required capability", context);
    if (input.candidateProfileIds !== undefined) {
      addDuplicateIssues(input.candidateProfileIds, "candidate profile", context);
    }
  });
export type TaskRouteInput = z.infer<typeof TaskRouteInputSchema>;

export const RoutingProfileSchema = z
  .object({
    profileId: IdSchema,
    profileVersion: VersionSchema,
    role: z.string().min(1).max(160),
    description: z.string().min(1).max(600),
    runtime: z.enum(["codex-cli", "claude-code"]),
    model: z.string().min(1).max(160),
    capabilities: z.array(IdSchema).max(64),
    enabled: z.boolean(),
    declaredAvailable: z.boolean(),
  })
  .strict()
  .superRefine((profile, context) => {
    addDuplicateIssues(profile.capabilities, "profile capability", context);
  });
export type RoutingProfile = z.infer<typeof RoutingProfileSchema>;

export const RoutingRegistrySchema = z
  .object({
    registryVersion: VersionSchema,
    profiles: z.array(RoutingProfileSchema).max(128),
  })
  .strict()
  .superRefine((registry, context) => {
    addDuplicateIssues(
      registry.profiles.map(({ profileId }) => profileId),
      "profile",
      context,
    );
  });
export type RoutingRegistry = z.infer<typeof RoutingRegistrySchema>;

export const RoutingPolicySchema = z
  .object({
    policyVersion: VersionSchema,
    allowedProfileIds: z.array(IdSchema).max(128),
    providerEnabled: z.boolean(),
    egressEnabled: z.boolean(),
    confidenceThreshold: z.number().min(0).max(1),
    deadlineMs: z.number().int().min(50).max(1_800_000),
    maxRequestBytes: z.number().int().min(1_024).max(262_144),
    maxResponseBytes: z.number().int().min(1_024).max(262_144),
  })
  .strict()
  .superRefine((policy, context) => {
    addDuplicateIssues(policy.allowedProfileIds, "allowed profile", context);
  });
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

const RoutingBindingSchema = z
  .object({
    delegationId: IdSchema,
    taskId: IdSchema,
    inputDigest: DigestSchema,
    registryVersion: VersionSchema,
    registryDigest: DigestSchema,
    policyVersion: VersionSchema,
    policyDigest: DigestSchema,
  })
  .strict();

const RoutingMetadataSchema = z
  .object({
    attempts: z.number().int().min(0).max(1),
    elapsedMs: z.number().int().nonnegative(),
    transportMode: z.enum(["live", "replay", "disabled"]),
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

const RoutedBaseSchema = {
  schemaVersion: z.literal("routing-v1"),
  binding: RoutingBindingSchema,
  metadata: RoutingMetadataSchema,
};

const SelectedProfileSchema = z
  .object({
    profileId: IdSchema,
    profileVersion: VersionSchema,
    runtime: z.enum(["codex-cli", "claude-code"]),
    model: z.string().min(1).max(160),
  })
  .strict();

export const TaskRouteResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...RoutedBaseSchema,
      status: z.literal("selected"),
      profile: SelectedProfileSchema,
      confidence: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      ...RoutedBaseSchema,
      status: z.literal("abstained"),
      reason: z.enum([
        "provider_disabled",
        "credentials_unavailable",
        "advisor_abstained",
        "confidence_below_threshold",
        "provider_timeout",
        "request_limit_exceeded",
        "response_limit_exceeded",
        "transport_failure",
        "invalid_provider_response",
      ]),
    })
    .strict(),
  z
    .object({
      ...RoutedBaseSchema,
      status: z.literal("needs_context"),
      reason: z.literal("context_not_ready"),
    })
    .strict(),
  z
    .object({
      ...RoutedBaseSchema,
      status: z.literal("no_eligible_target"),
      reason: z.enum(["no_eligible_profile", "unknown_candidate_profile"]),
    })
    .strict(),
  z
    .object({
      ...RoutedBaseSchema,
      status: z.literal("cancelled"),
      reason: z.literal("caller_cancelled"),
    })
    .strict(),
]);
export type TaskRouteResult = z.infer<typeof TaskRouteResultSchema>;

export const RoutingErrorSchema = z
  .object({
    status: z.literal("error"),
    reason: z.enum(["invalid_routing_request", "routing_failed"]),
  })
  .strict();
export type RoutingError = z.infer<typeof RoutingErrorSchema>;

export const AdvisorObservationSchema = z
  .object({
    model: z.literal("jev-1.13.0"),
    answers: z
      .object({
        route: z
          .object({
            type: z.literal("choice"),
            choice: z.string().min(1),
            confidence: z.number().min(0).max(1),
            probabilities: z.record(z.string(), z.number().min(0).max(1)),
          })
          .strict(),
      })
      .strict(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type AdvisorObservation = z.infer<typeof AdvisorObservationSchema>;

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
