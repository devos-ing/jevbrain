import type { z } from "zod";
import { digestJson } from "../benchmark/io.ts";
import type {
  RoutingPolicy,
  RoutingRegistry,
  TaskRouteInput,
  TaskRouteResult,
} from "../route/contracts.ts";
import type {
  EvalCase,
  EvalCountsSchema,
  EvalRow,
  EvalSummary,
  EvalVerdict,
  NeutralObservation,
} from "./contracts.ts";
import { EvalSummarySchema, EvalVerdictSchema, NeutralObservationSchema } from "./contracts.ts";

export function neutralizeRouterResult(result: TaskRouteResult): NeutralObservation {
  return NeutralObservationSchema.parse({
    decision: result.status,
    ...(result.status === "selected" ? { selectedProfileId: result.profile.profileId } : {}),
    reason: "reason" in result ? result.reason : "selected",
    ...(result.status === "selected" ? { confidence: result.confidence } : {}),
    attempts: result.metadata.attempts,
    elapsedMs: result.metadata.elapsedMs,
    transportMode: result.metadata.transportMode,
    ...(result.metadata.provider === undefined ? {} : { provider: result.metadata.provider }),
    binding: result.binding,
  });
}

export function evaluateObservation(
  observation: NeutralObservation,
  benchmarkCase: EvalCase,
): EvalVerdict {
  if (observation.decision === "selected") {
    return EvalVerdictSchema.parse(
      benchmarkCase.labels.acceptableOutcomes.includes("selected") &&
        benchmarkCase.labels.acceptableProfileIds.includes(observation.selectedProfileId ?? "")
        ? { status: "accepted", reason: "acceptable_selection" }
        : { status: "rejected", reason: "wrong_selection" },
    );
  }
  if (observation.decision === "cancelled") {
    return EvalVerdictSchema.parse({ status: "error", reason: "cancelled" });
  }
  const expectedKind = outcomeKind(observation);
  if (expectedKind !== undefined) {
    return EvalVerdictSchema.parse(
      benchmarkCase.labels.acceptableOutcomes.includes(expectedKind)
        ? { status: "accepted", reason: "intentional_abstain" }
        : { status: "rejected", reason: "unexpected_abstain" },
    );
  }
  return EvalVerdictSchema.parse({ status: "error", reason: "operational_error" });
}

export function isAdmissibleSelection(
  profileId: string,
  request: TaskRouteInput,
  registry: RoutingRegistry,
  policy: RoutingPolicy,
): boolean {
  if (request.contextStatus !== "ready") return false;
  const knownProfileIds = new Set(registry.profiles.map(({ profileId: id }) => id));
  if (request.candidateProfileIds?.some((id) => !knownProfileIds.has(id))) return false;
  const profile = registry.profiles.find((item) => item.profileId === profileId);
  if (profile === undefined) return false;
  return (
    policy.allowedProfileIds.includes(profileId) &&
    (request.candidateProfileIds === undefined ||
      request.candidateProfileIds.includes(profileId)) &&
    profile.enabled &&
    profile.declaredAvailable &&
    request.requiredCapabilities.every((capability) => profile.capabilities.includes(capability))
  );
}

function outcomeKind(
  observation: NeutralObservation,
): "advisor_abstain" | "confidence_abstain" | "needs_context" | "no_eligible_target" | undefined {
  if (observation.decision === "abstained" && observation.reason === "advisor_abstained") {
    return "advisor_abstain";
  }
  if (observation.decision === "abstained" && observation.reason === "confidence_below_threshold") {
    return "confidence_abstain";
  }
  if (observation.decision === "needs_context" && observation.reason === "context_not_ready") {
    return "needs_context";
  }
  if (
    observation.decision === "no_eligible_target" &&
    (observation.reason === "no_eligible_profile" ||
      observation.reason === "unknown_candidate_profile")
  ) {
    return "no_eligible_target";
  }
  return undefined;
}

export function fixtureDigest(benchmarkCase: EvalCase): `sha256:${string}` {
  return digestJson({
    caseId: benchmarkCase.caseId,
    caseVersion: benchmarkCase.caseVersion,
    split: benchmarkCase.split,
    theme: benchmarkCase.theme,
    request: benchmarkCase.request,
    labels: benchmarkCase.labels,
  });
}

export function summarizeEval(runId: string, rows: readonly EvalRow[]): EvalSummary {
  const total = segment(rows);
  const tuning = segment(rows.filter(({ split }) => split === "tuning"));
  const heldout = segment(rows.filter(({ split }) => split === "heldout"));
  const suitability = segment(rows.filter(({ theme }) => theme !== "missing_context"));
  const readiness = segment(rows.filter(({ theme }) => theme === "missing_context"));
  const providers = rows.flatMap(({ observation }) =>
    observation?.provider === undefined ? [] : [observation.provider],
  );
  return EvalSummarySchema.parse({
    schemaVersion: "routing-eval-summary-v1",
    runId,
    complete: total.notRun === 0 && total.cancelled === 0,
    total,
    tuning,
    heldout,
    suitability,
    readiness,
    providerUsage: {
      kind:
        providers.length === 0
          ? "unavailable"
          : rows.some(({ observation }) => observation?.transportMode === "live")
            ? "reported"
            : "synthetic",
      observedCount: providers.length,
      unavailableCount: rows.length - providers.length,
      inputTokens: providers.reduce((sum, provider) => sum + provider.usage.inputTokens, 0),
      outputTokens: providers.reduce((sum, provider) => sum + provider.usage.outputTokens, 0),
    },
  });
}

function segment(rows: readonly EvalRow[]) {
  const elapsed = rows.flatMap(({ observation }) =>
    observation === null ? [] : [observation.elapsedMs],
  );
  const sorted = [...elapsed].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? (sorted[midpoint] ?? null)
        : ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
  return {
    ...counts(rows),
    latency: {
      observedCount: elapsed.length,
      medianMs: median,
      minMs: sorted[0] ?? null,
      maxMs: sorted.at(-1) ?? null,
    },
  };
}

function counts(rows: readonly EvalRow[]): z.infer<typeof EvalCountsSchema> {
  return {
    planned: rows.length,
    observed: rows.filter(({ observation }) => observation !== null).length,
    accepted: rows.filter(({ verdict }) => verdict.status === "accepted").length,
    wrongSelections: rows.filter(({ verdict }) => verdict.reason === "wrong_selection").length,
    intentionalAbstain: rows.filter(
      ({ observation }) =>
        observation?.reason === "advisor_abstained" ||
        observation?.reason === "confidence_below_threshold",
    ).length,
    operationalErrors: rows.filter(({ verdict }) => verdict.reason === "operational_error").length,
    cancelled: rows.filter(({ executionStatus }) => executionStatus === "cancelled").length,
    notRun: rows.filter(({ executionStatus }) => executionStatus === "not_run").length,
  };
}
