import type { RoutingPolicy, RoutingProfile, TaskRouteInput } from "./contracts.ts";

export const ABSTAIN_OPTION = "__abstain__";

export type AdvisorRequest = {
  input: TaskRouteInput;
  eligibleProfiles: readonly RoutingProfile[];
  policy: RoutingPolicy;
  signal: AbortSignal;
};

export type RouteAdvisor = {
  transportMode: "live" | "replay";
  route(request: AdvisorRequest): Promise<{ observation: unknown; attempts: number }>;
};

export class AdvisorTransportError extends Error {
  constructor(
    readonly reason:
      | "provider_timeout"
      | "request_limit_exceeded"
      | "response_limit_exceeded"
      | "transport_failure",
    readonly attempts: number,
  ) {
    super(reason);
  }
}

export class AdvisorCancellationError extends Error {
  constructor(readonly attempts: number) {
    super("caller_cancelled");
  }
}
