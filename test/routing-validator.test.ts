import { describe, expect, test } from "bun:test";
import type { AgentProfile, DecisionObservation, RoutingInput } from "../src/contracts.ts";
import { validateRecordedResponse } from "../src/routing/validate-recorded-response.ts";

const input: RoutingInput = {
  inputId: "input-one",
  delegationId: "delegation-one",
  task: { taskId: "task-one", objective: "Route a synthetic task", requiredCapabilities: [] },
  suppliedContext: [],
  candidateProfileIds: ["profile-one"],
};
const profiles: AgentProfile[] = [
  {
    profileId: "profile-one",
    runtime: "codex-cli",
    modelId: "synthetic-model",
    enabled: true,
    capabilities: [],
  },
  {
    profileId: "profile-two",
    runtime: "claude-code",
    modelId: "synthetic-model",
    enabled: true,
    capabilities: [],
  },
];
type RejectionReason = Extract<DecisionObservation, { status: "rejected" }>["reason"];
const invalidCases: ReadonlyArray<readonly [string, RejectionReason]> = [
  ["not json", "malformed_response"],
  [
    JSON.stringify({ outcome: "abstained", delegationId: "wrong", reasonCode: "uncertain" }),
    "delegation_mismatch",
  ],
  [
    JSON.stringify({
      outcome: "selected",
      delegationId: "delegation-one",
      profileId: "unknown",
      reasonCode: "match",
    }),
    "unknown_profile",
  ],
  [
    JSON.stringify({
      outcome: "selected",
      delegationId: "delegation-one",
      profileId: "profile-two",
      reasonCode: "match",
    }),
    "profile_not_supplied",
  ],
];

describe("recorded response validation", () => {
  test("accepts selected and abstained decisions", () => {
    expect(
      validateRecordedResponse(
        input,
        profiles,
        JSON.stringify({
          outcome: "selected",
          delegationId: "delegation-one",
          profileId: "profile-one",
          reasonCode: "match",
        }),
      ).status,
    ).toBe("accepted");
    expect(
      validateRecordedResponse(
        input,
        profiles,
        JSON.stringify({
          outcome: "abstained",
          delegationId: "delegation-one",
          reasonCode: "uncertain",
        }),
      ).status,
    ).toBe("accepted");
  });

  test.each(invalidCases)("rejects invalid response %s", (responseText, reason) => {
    expect(validateRecordedResponse(input, profiles, responseText)).toEqual({
      status: "rejected",
      reason,
    });
  });
});
