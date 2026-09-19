import { digestJson } from "../benchmark/io.ts";
import type { RoutingPolicy, RoutingRegistry, TaskRouteInput } from "../route/contracts.ts";
import { findEligible } from "../route/router.ts";
import { type NeutralObservation, NeutralObservationSchema } from "./contracts.ts";

export function routeByFirstEligible(
  input: TaskRouteInput,
  registry: RoutingRegistry,
  policy: RoutingPolicy,
): NeutralObservation {
  const startedAt = performance.now();
  const binding = {
    delegationId: input.delegationId,
    taskId: input.taskId,
    inputDigest: digestJson(input),
    registryVersion: registry.registryVersion,
    registryDigest: digestJson(registry),
    policyVersion: policy.policyVersion,
    policyDigest: digestJson(policy),
  };
  if (input.contextStatus !== "ready") {
    return build("needs_context", "context_not_ready", binding, startedAt);
  }
  const known = new Set(registry.profiles.map(({ profileId }) => profileId));
  if (input.candidateProfileIds?.some((profileId) => !known.has(profileId))) {
    return build("no_eligible_target", "unknown_candidate_profile", binding, startedAt);
  }
  const selected = findEligible(input, registry, policy)[0];
  if (selected === undefined) {
    return build("no_eligible_target", "no_eligible_profile", binding, startedAt);
  }
  return NeutralObservationSchema.parse({
    decision: "selected",
    selectedProfileId: selected.profileId,
    reason: "first_eligible",
    attempts: 0,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    transportMode: "rules",
    binding,
  });
}

function build(
  decision: "needs_context" | "no_eligible_target",
  reason: string,
  binding: NeutralObservation["binding"],
  startedAt: number,
): NeutralObservation {
  return NeutralObservationSchema.parse({
    decision,
    reason,
    attempts: 0,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    transportMode: "rules",
    binding,
  });
}
