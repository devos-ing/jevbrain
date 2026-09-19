import {
  type ContextManifestEntry,
  type ContextSplitOutcome,
  ContextSplitOutcomeSchema,
  ContextSplitRequestSchema,
  type TrustedContextPolicy,
  TrustedContextPolicySchema,
} from "./contracts.ts";
import { contentDigest, contextDigest } from "./digest.ts";

export function splitContext(
  requestInput: unknown,
  trustedPolicyInput: unknown,
): ContextSplitOutcome {
  const requestResult = ContextSplitRequestSchema.safeParse(requestInput);
  if (!requestResult.success) {
    return ContextSplitOutcomeSchema.parse({ status: "rejected", reason: "invalid_request" });
  }
  const policyResult = TrustedContextPolicySchema.safeParse(trustedPolicyInput);
  if (!policyResult.success) {
    return ContextSplitOutcomeSchema.parse({ status: "rejected", reason: "invalid_policy" });
  }
  const request = requestResult.data;
  const policy = policyResult.data;
  if (request.delegationId !== policy.delegationId) {
    return ContextSplitOutcomeSchema.parse({ status: "rejected", reason: "delegation_mismatch" });
  }

  const references = new Map(
    request.references.map((reference) => [reference.sourceId, reference]),
  );
  const catalog = new Map(policy.catalog.map((entry) => [entry.sourceId, entry]));
  const requiredIds = new Set([
    ...policy.mandatorySourceIds,
    ...request.references
      .filter(({ category }) => category === "required")
      .map(({ sourceId }) => sourceId),
  ]);
  const admitted: ContextManifestEntry[] = [];
  let denied = 0;
  let unavailable = 0;
  let missingRequiredCount = 0;

  for (const sourceId of new Set([...references.keys(), ...policy.mandatorySourceIds])) {
    const reference = references.get(sourceId);
    const entry = catalog.get(sourceId);
    const required = requiredIds.has(sourceId);
    const mandatory = policy.mandatorySourceIds.includes(sourceId);
    const denial =
      entry === undefined || (!mandatory && reference === undefined) || !isEligible(entry, policy);
    if (denial) {
      denied += 1;
      if (required) missingRequiredCount += 1;
      continue;
    }
    if (entry.availability.status !== "available") {
      unavailable += 1;
      if (required) missingRequiredCount += 1;
      continue;
    }
    const digest = contentDigest(entry.availability.text);
    admitted.push({
      sourceId,
      sourceVersion: entry.sourceVersion,
      category: required ? "required" : (reference?.category ?? "required"),
      relevanceLabel: reference?.relevanceLabel ?? null,
      contentDigest: digest,
      utf8Bytes: Buffer.byteLength(entry.availability.text, "utf8"),
      text: entry.availability.text,
    });
  }

  const omissions = { denied, unavailable };
  if (missingRequiredCount > 0) {
    return ContextSplitOutcomeSchema.parse({
      status: "needs_context",
      reason: "required_context_unavailable",
      missingRequiredCount,
      omissions,
    });
  }

  admitted.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const manifestCore = {
    schemaVersion: "context-v1" as const,
    delegationId: request.delegationId,
    policyVersion: policy.policyVersion,
    repositoryNamespace: policy.repositoryNamespace,
    briefing: request.briefing,
    entries: admitted,
  };
  const manifest = { ...manifestCore, manifestDigest: contextDigest(manifestCore) };
  return ContextSplitOutcomeSchema.parse({
    status: "ready",
    manifest,
    grant: {
      grantKind: "data_sharing_only",
      enforcement: "declarative",
      delegationId: request.delegationId,
      policyVersion: policy.policyVersion,
      repositoryNamespace: policy.repositoryNamespace,
      admittedSources: admitted.map(({ sourceId, contentDigest: digest }) => ({
        sourceId,
        contentDigest: digest,
      })),
    },
    omissions,
  });
}

function isEligible(
  entry: TrustedContextPolicy["catalog"][number],
  policy: TrustedContextPolicy,
): boolean {
  if (!policy.allowedSourceIds.includes(entry.sourceId)) return false;
  if (entry.repositoryNamespace !== policy.repositoryNamespace) return false;
  if (entry.visibility === "forbidden") return false;
  if (entry.visibility === "shared") return policy.allowShared;
  return entry.ownerDelegationId === policy.delegationId;
}
