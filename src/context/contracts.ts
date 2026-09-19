import { z } from "zod";

const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]*$/);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const NonemptyTextSchema = z.string().min(1);

export const ContextCategorySchema = z.enum(["required", "shared", "evidence", "optional"]);

export const ContextSplitRequestSchema = z
  .object({
    delegationId: IdSchema,
    briefing: z
      .object({
        objective: NonemptyTextSchema,
        acceptanceCriteria: z.array(NonemptyTextSchema).min(1),
        constraints: z.array(NonemptyTextSchema),
        decisions: z.array(NonemptyTextSchema),
      })
      .strict(),
    references: z.array(
      z
        .object({
          sourceId: IdSchema,
          category: ContextCategorySchema,
          relevanceLabel: NonemptyTextSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((request, context) => {
    addDuplicateIssues(
      request.references.map(({ sourceId }) => sourceId),
      "request reference",
      context,
    );
  });
export type ContextSplitRequest = z.infer<typeof ContextSplitRequestSchema>;

const SourceAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), text: z.string() }).strict(),
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);

const TrustedCatalogEntrySchema = z
  .object({
    sourceId: IdSchema,
    sourceVersion: VersionSchema,
    repositoryNamespace: IdSchema,
    visibility: z.enum(["shared", "delegation_private", "forbidden"]),
    ownerDelegationId: IdSchema.optional(),
    availability: SourceAvailabilitySchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.visibility === "delegation_private" && entry.ownerDelegationId === undefined) {
      context.addIssue({ code: "custom", message: "private catalog entry requires an owner" });
    }
    if (entry.visibility !== "delegation_private" && entry.ownerDelegationId !== undefined) {
      context.addIssue({ code: "custom", message: "only private catalog entries have owners" });
    }
  });

export const TrustedContextPolicySchema = z
  .object({
    delegationId: IdSchema,
    policyVersion: VersionSchema,
    repositoryNamespace: IdSchema,
    allowShared: z.boolean(),
    allowedSourceIds: z.array(IdSchema),
    mandatorySourceIds: z.array(IdSchema),
    catalog: z.array(TrustedCatalogEntrySchema),
  })
  .strict()
  .superRefine((policy, context) => {
    addDuplicateIssues(policy.allowedSourceIds, "allowed source", context);
    addDuplicateIssues(policy.mandatorySourceIds, "mandatory source", context);
    addDuplicateIssues(
      policy.catalog.map(({ sourceId }) => sourceId),
      "catalog source",
      context,
    );
  });
export type TrustedContextPolicy = z.infer<typeof TrustedContextPolicySchema>;

const BriefingSchema = ContextSplitRequestSchema.shape.briefing;
const OmissionCountsSchema = z
  .object({ denied: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative() })
  .strict();

export const ContextManifestEntrySchema = z
  .object({
    sourceId: IdSchema,
    sourceVersion: VersionSchema,
    category: ContextCategorySchema,
    relevanceLabel: NonemptyTextSchema.nullable(),
    contentDigest: DigestSchema,
    utf8Bytes: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict();
export type ContextManifestEntry = z.infer<typeof ContextManifestEntrySchema>;

export const ContextManifestSchema = z
  .object({
    schemaVersion: z.literal("context-v1"),
    delegationId: IdSchema,
    policyVersion: VersionSchema,
    repositoryNamespace: IdSchema,
    briefing: BriefingSchema,
    entries: z.array(ContextManifestEntrySchema),
    manifestDigest: DigestSchema,
  })
  .strict();

export const ContextGrantSchema = z
  .object({
    grantKind: z.literal("data_sharing_only"),
    enforcement: z.literal("declarative"),
    delegationId: IdSchema,
    policyVersion: VersionSchema,
    repositoryNamespace: IdSchema,
    admittedSources: z.array(
      z.object({ sourceId: IdSchema, contentDigest: DigestSchema }).strict(),
    ),
  })
  .strict();

export const ContextSplitOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      manifest: ContextManifestSchema,
      grant: ContextGrantSchema,
      omissions: OmissionCountsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("needs_context"),
      reason: z.literal("required_context_unavailable"),
      missingRequiredCount: z.number().int().positive(),
      omissions: OmissionCountsSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum(["invalid_request", "invalid_policy", "delegation_mismatch"]),
    })
    .strict(),
]);
export type ContextSplitOutcome = z.infer<typeof ContextSplitOutcomeSchema>;

export const ContextCliErrorSchema = z
  .object({
    status: z.literal("error"),
    reason: z.enum(["request_input_unreadable", "policy_input_unreadable"]),
  })
  .strict();
export type ContextCliError = z.infer<typeof ContextCliErrorSchema>;

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
