import { digestJson } from "../benchmark/io.ts";
import {
  ABSTAIN_OPTION,
  AdvisorCancellationError,
  AdvisorTransportError,
  type RouteAdvisor,
} from "./advisor.ts";
import {
  AdvisorObservationSchema,
  type RoutingPolicy,
  RoutingPolicySchema,
  type RoutingProfile,
  type RoutingRegistry,
  RoutingRegistrySchema,
  type TaskRouteInput,
  TaskRouteInputSchema,
  type TaskRouteResult,
  TaskRouteResultSchema,
} from "./contracts.ts";

export type RouterStartup = {
  registry: unknown;
  policy: unknown;
  apiKey?: string;
  advisor?: RouteAdvisor;
};

export function createTaskRouter(startup: RouterStartup) {
  const registry = RoutingRegistrySchema.parse(startup.registry);
  const policy = RoutingPolicySchema.parse(startup.policy);
  const registryIds = new Set(registry.profiles.map(({ profileId }) => profileId));
  if (policy.allowedProfileIds.some((profileId) => !registryIds.has(profileId))) {
    throw new Error("routing policy references an unknown profile");
  }
  const snapshot = { registry, policy };

  return async (rawInput: unknown, signal: AbortSignal): Promise<TaskRouteResult> => {
    const startedAt = performance.now();
    const input = TaskRouteInputSchema.parse(rawInput);
    const binding = bindingFor(input, snapshot.registry, snapshot.policy);
    const metadata = (
      attempts: number,
      transportMode: "live" | "replay" | "disabled",
      provider?: { model: "jev-1.13.0"; usage: { inputTokens: number; outputTokens: number } },
    ) => ({
      attempts,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      transportMode,
      ...(provider === undefined ? {} : { provider }),
    });
    if (signal.aborted) {
      return TaskRouteResultSchema.parse({
        schemaVersion: "routing-v1",
        status: "cancelled",
        reason: "caller_cancelled",
        binding,
        metadata: metadata(0, "disabled"),
      });
    }
    if (input.contextStatus !== "ready") {
      return TaskRouteResultSchema.parse({
        schemaVersion: "routing-v1",
        status: "needs_context",
        reason: "context_not_ready",
        binding,
        metadata: metadata(0, "disabled"),
      });
    }
    const knownIds = new Set(registry.profiles.map(({ profileId }) => profileId));
    if (input.candidateProfileIds?.some((profileId) => !knownIds.has(profileId))) {
      return TaskRouteResultSchema.parse({
        schemaVersion: "routing-v1",
        status: "no_eligible_target",
        reason: "unknown_candidate_profile",
        binding,
        metadata: metadata(0, "disabled"),
      });
    }
    const eligibleProfiles = findEligible(input, registry, policy);
    if (eligibleProfiles.length === 0) {
      return TaskRouteResultSchema.parse({
        schemaVersion: "routing-v1",
        status: "no_eligible_target",
        reason: "no_eligible_profile",
        binding,
        metadata: metadata(0, "disabled"),
      });
    }
    if (!policy.providerEnabled || !policy.egressEnabled) {
      return TaskRouteResultSchema.parse({
        schemaVersion: "routing-v1",
        status: "abstained",
        reason: "provider_disabled",
        binding,
        metadata: metadata(0, "disabled"),
      });
    }
    if (
      startup.apiKey === undefined ||
      startup.apiKey.length === 0 ||
      startup.advisor === undefined
    ) {
      return TaskRouteResultSchema.parse({
        schemaVersion: "routing-v1",
        status: "abstained",
        reason: "credentials_unavailable",
        binding,
        metadata: metadata(0, "disabled"),
      });
    }
    try {
      const advised = await startup.advisor.route({
        input,
        eligibleProfiles,
        policy,
        signal,
      });
      if (signal.aborted) {
        return TaskRouteResultSchema.parse({
          schemaVersion: "routing-v1",
          status: "cancelled",
          reason: "caller_cancelled",
          binding,
          metadata: metadata(advised.attempts, startup.advisor.transportMode),
        });
      }
      const observation = AdvisorObservationSchema.safeParse(advised.observation);
      const attempts = advised.attempts;
      if (!observation.success || !validChoiceShape(observation.data, eligibleProfiles)) {
        return TaskRouteResultSchema.parse({
          schemaVersion: "routing-v1",
          status: "abstained",
          reason: "invalid_provider_response",
          binding,
          metadata: metadata(attempts, startup.advisor.transportMode),
        });
      }
      const answer = observation.data.answers.route;
      const provider = {
        model: observation.data.model,
        usage: {
          inputTokens: observation.data.usage.input_tokens,
          outputTokens: observation.data.usage.output_tokens,
        },
      };
      if (answer.choice === ABSTAIN_OPTION) {
        return TaskRouteResultSchema.parse({
          schemaVersion: "routing-v1",
          status: "abstained",
          reason: "advisor_abstained",
          binding,
          metadata: metadata(attempts, startup.advisor.transportMode, provider),
        });
      }
      if (answer.confidence < policy.confidenceThreshold) {
        return TaskRouteResultSchema.parse({
          schemaVersion: "routing-v1",
          status: "abstained",
          reason: "confidence_below_threshold",
          binding,
          metadata: metadata(attempts, startup.advisor.transportMode, provider),
        });
      }
      const selected = eligibleProfiles.find(({ profileId }) => profileId === answer.choice);
      if (selected === undefined)
        throw new Error("validated choice missing from eligible profiles");
      return TaskRouteResultSchema.parse({
        schemaVersion: "routing-v1",
        status: "selected",
        binding,
        profile: {
          profileId: selected.profileId,
          profileVersion: selected.profileVersion,
          runtime: selected.runtime,
          model: selected.model,
        },
        confidence: answer.confidence,
        metadata: metadata(attempts, startup.advisor.transportMode, provider),
      });
    } catch (error: unknown) {
      if (signal.aborted) {
        return TaskRouteResultSchema.parse({
          schemaVersion: "routing-v1",
          status: "cancelled",
          reason: "caller_cancelled",
          binding,
          metadata: metadata(
            error instanceof AdvisorTransportError || error instanceof AdvisorCancellationError
              ? error.attempts
              : 0,
            startup.advisor.transportMode,
          ),
        });
      }
      return TaskRouteResultSchema.parse({
        schemaVersion: "routing-v1",
        status: "abstained",
        reason: error instanceof AdvisorTransportError ? error.reason : "transport_failure",
        binding,
        metadata: metadata(
          error instanceof AdvisorTransportError ? error.attempts : 0,
          startup.advisor.transportMode,
        ),
      });
    }
  };
}

function bindingFor(input: TaskRouteInput, registry: RoutingRegistry, policy: RoutingPolicy) {
  return {
    delegationId: input.delegationId,
    taskId: input.taskId,
    inputDigest: digestJson(input),
    registryVersion: registry.registryVersion,
    registryDigest: digestJson(registry),
    policyVersion: policy.policyVersion,
    policyDigest: digestJson(policy),
  };
}

export function findEligible(
  input: TaskRouteInput,
  registry: RoutingRegistry,
  policy: RoutingPolicy,
): RoutingProfile[] {
  const allowed = new Set(policy.allowedProfileIds);
  const narrowed =
    input.candidateProfileIds === undefined ? undefined : new Set(input.candidateProfileIds);
  return registry.profiles.filter(
    (profile) =>
      allowed.has(profile.profileId) &&
      (narrowed === undefined || narrowed.has(profile.profileId)) &&
      profile.enabled &&
      profile.declaredAvailable &&
      input.requiredCapabilities.every((capability) => profile.capabilities.includes(capability)),
  );
}

function validChoiceShape(
  observation: ReturnType<typeof AdvisorObservationSchema.parse>,
  profiles: readonly RoutingProfile[],
): boolean {
  const allowed = new Set([...profiles.map(({ profileId }) => profileId), ABSTAIN_OPTION]);
  const answer = observation.answers.route;
  const probabilityKeys = Object.keys(answer.probabilities);
  const probabilitySum = Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0);
  return (
    allowed.has(answer.choice) &&
    probabilityKeys.length === allowed.size &&
    probabilityKeys.every((key) => allowed.has(key)) &&
    Math.abs(probabilitySum - 1) <= 0.000001
  );
}
