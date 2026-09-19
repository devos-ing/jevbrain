import type { AgentProfile, DecisionObservation, RoutingInput } from "../contracts.ts";
import { RouteDecisionSchema } from "../contracts.ts";

export function validateRecordedResponse(
  input: RoutingInput,
  profiles: readonly AgentProfile[],
  responseText: string,
): DecisionObservation {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(responseText) as unknown;
  } catch {
    return { status: "rejected", reason: "malformed_response" };
  }
  const parsedDecision = RouteDecisionSchema.safeParse(parsedJson);
  if (!parsedDecision.success) return { status: "rejected", reason: "malformed_response" };
  if (parsedDecision.data.delegationId !== input.delegationId) {
    return { status: "rejected", reason: "delegation_mismatch" };
  }
  if (parsedDecision.data.outcome === "selected") {
    const selectedProfileId = parsedDecision.data.profileId;
    const profileExists = profiles.some(({ profileId }) => profileId === selectedProfileId);
    if (!profileExists) return { status: "rejected", reason: "unknown_profile" };
    if (!input.candidateProfileIds.includes(selectedProfileId)) {
      return { status: "rejected", reason: "profile_not_supplied" };
    }
  }
  return { status: "accepted", decision: parsedDecision.data };
}
