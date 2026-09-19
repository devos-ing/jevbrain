import type { ContextExpectation } from "./benchmark-contracts.ts";
import type { ContextSplitOutcome } from "./contracts.ts";
import { contentDigest, contextDigest } from "./digest.ts";

export function matchesContextExpectation(
  outcome: ContextSplitOutcome,
  expected: ContextExpectation,
): boolean {
  if (outcome.status !== expected.status) return false;
  if (outcome.status === "ready" && expected.status === "ready") {
    const manifestCore = {
      schemaVersion: outcome.manifest.schemaVersion,
      delegationId: outcome.manifest.delegationId,
      policyVersion: outcome.manifest.policyVersion,
      repositoryNamespace: outcome.manifest.repositoryNamespace,
      briefing: outcome.manifest.briefing,
      entries: outcome.manifest.entries,
    };
    return (
      outcome.manifest.delegationId === expected.delegationId &&
      outcome.manifest.policyVersion === expected.policyVersion &&
      outcome.manifest.repositoryNamespace === expected.repositoryNamespace &&
      contextDigest(outcome.manifest.briefing) === expected.briefingDigest &&
      contextDigest(manifestCore) === outcome.manifest.manifestDigest &&
      outcome.manifest.entries.every(
        ({ text, contentDigest: digest, utf8Bytes }) =>
          contentDigest(text) === digest && Buffer.byteLength(text, "utf8") === utf8Bytes,
      ) &&
      JSON.stringify(
        outcome.manifest.entries.map(({ sourceId, category, contentDigest: digest }) => ({
          sourceId,
          category,
          contentDigest: digest,
        })),
      ) === JSON.stringify(expected.admittedSources) &&
      outcome.grant.delegationId === outcome.manifest.delegationId &&
      outcome.grant.policyVersion === outcome.manifest.policyVersion &&
      outcome.grant.repositoryNamespace === outcome.manifest.repositoryNamespace &&
      JSON.stringify(outcome.grant.admittedSources) ===
        JSON.stringify(
          outcome.manifest.entries.map(({ sourceId, contentDigest: digest }) => ({
            sourceId,
            contentDigest: digest,
          })),
        ) &&
      outcome.omissions.denied === expected.deniedCount &&
      outcome.omissions.unavailable === expected.unavailableCount
    );
  }
  if (outcome.status === "needs_context" && expected.status === "needs_context") {
    return outcome.missingRequiredCount === expected.missingRequiredCount;
  }
  if (outcome.status === "rejected" && expected.status === "rejected") {
    return outcome.reason === expected.reason;
  }
  return false;
}
