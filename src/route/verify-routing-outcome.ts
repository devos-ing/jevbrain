import type { z } from "zod";
import type { RoutingExpectationSchema } from "./benchmark-contracts.ts";

type ExpectedBinding = z.infer<typeof TaskRouteResultSchema>["binding"];

import type { TaskRouteResultSchema } from "./contracts.ts";

export function matchesRoutingExpectation(
  outcome: z.infer<typeof TaskRouteResultSchema>,
  expected: z.infer<typeof RoutingExpectationSchema>,
  expectedBinding: ExpectedBinding,
): boolean {
  if (
    outcome.status !== expected.status ||
    outcome.metadata.attempts !== expected.attempts ||
    outcome.metadata.transportMode !== expected.transportMode ||
    JSON.stringify(outcome.metadata.provider) !== JSON.stringify(expected.provider) ||
    JSON.stringify(outcome.binding) !== JSON.stringify(expectedBinding)
  )
    return false;
  if ("reason" in outcome && expected.reason !== outcome.reason) return false;
  if (!("reason" in outcome) && expected.reason !== undefined) return false;
  if (outcome.status === "selected") {
    return JSON.stringify(outcome.profile) === JSON.stringify(expected.profile);
  }
  return expected.profile === undefined;
}
