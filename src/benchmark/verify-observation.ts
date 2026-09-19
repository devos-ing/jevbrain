import type { DecisionObservation, ReplayExpectation } from "../contracts.ts";

export function matchesExpectation(
  observation: DecisionObservation,
  expected: ReplayExpectation,
): boolean {
  if (observation.status !== expected.status) return false;
  if (observation.status === "rejected" && expected.status === "rejected") {
    return observation.reason === expected.reason;
  }
  if (observation.status === "accepted" && expected.status === "accepted") {
    return observation.decision.outcome === expected.outcome;
  }
  return false;
}
