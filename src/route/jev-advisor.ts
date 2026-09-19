import {
  APIUserAbortError,
  choice,
  type Fetch,
  type Logger,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { z } from "zod";
import {
  ABSTAIN_OPTION,
  AdvisorCancellationError,
  type AdvisorRequest,
  AdvisorTransportError,
  type RouteAdvisor,
} from "./advisor.ts";

export const TYPESAFE_ORIGIN = "https://api.typesafe.ai";
export const TYPESAFE_SYSTEM_ONE_URL = `${TYPESAFE_ORIGIN}/v1/systemone`;
export const JEV_MODEL = "jev-1.13.0";
const WIRE_ABSTAIN_OPTION = "option_abstain";

const silentLogger: Logger = {
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
};

export function createJevAdvisor(options: {
  apiKey: string;
  fetch?: Fetch;
  transportMode?: "live" | "replay";
  disableBunIdleTimeout?: boolean;
}): RouteAdvisor {
  return {
    transportMode: options.transportMode ?? "live",
    async route(request: AdvisorRequest): Promise<{ observation: unknown; attempts: number }> {
      let attempts = 0;
      let guardedFailure:
        | "provider_timeout"
        | "request_limit_exceeded"
        | "response_limit_exceeded"
        | "transport_failure"
        | undefined;
      const aliases = new Map(
        request.eligibleProfiles.map((profile, index) => [
          `option_${index + 1}`,
          profile.profileId,
        ]),
      );
      const guardedFetch: Fetch = async (input, init) => {
        if (input !== TYPESAFE_SYSTEM_ONE_URL || init?.method !== "POST") {
          guardedFailure = "transport_failure";
          throw new AdvisorTransportError("transport_failure", attempts);
        }
        const body = typeof init.body === "string" ? init.body : "";
        if (new TextEncoder().encode(body).byteLength > request.policy.maxRequestBytes) {
          guardedFailure = "request_limit_exceeded";
          throw new AdvisorTransportError("request_limit_exceeded", attempts);
        }
        attempts += 1;
        if (attempts > 1) throw new AdvisorTransportError("transport_failure", attempts);
        const effectiveSignal = init?.signal;
        if (effectiveSignal === undefined || effectiveSignal === null) {
          guardedFailure = "transport_failure";
          throw new AdvisorTransportError("transport_failure", attempts);
        }
        const fetchImpl = options.fetch ?? fetch;
        try {
          const response = await fetchImpl(input, {
            ...init,
            redirect: "error",
            ...(options.disableBunIdleTimeout ? { timeout: 0 as const } : {}),
          });
          if (effectiveSignal.aborted) {
            if (response.body !== null) void response.body.cancel().catch(() => {});
            guardedFailure = "provider_timeout";
            throw new AdvisorTransportError("provider_timeout", attempts);
          }
          return await capResponse(response, request.policy.maxResponseBytes, effectiveSignal);
        } catch (error: unknown) {
          guardedFailure =
            error instanceof AdvisorTransportError && error.reason !== "request_limit_exceeded"
              ? error.reason
              : "transport_failure";
          throw error;
        }
      };
      const client = new TypeSafeClient({
        apiKey: options.apiKey,
        baseURL: TYPESAFE_ORIGIN,
        defaultModel: JEV_MODEL,
        logLevel: "off",
        logger: silentLogger,
        retry: { maxRetries: 0 },
        timeout: request.policy.deadlineMs,
        fetch: guardedFetch,
      });
      const criteria = Object.fromEntries([
        ...request.eligibleProfiles.map((profile, index) => [
          `option_${index + 1}`,
          {
            role: profile.role,
            description: profile.description,
            runtime: profile.runtime,
            model: profile.model,
            capabilities: profile.capabilities,
          },
        ]),
        [WIRE_ABSTAIN_OPTION, "No registered profile is a sufficiently certain fit."],
      ]);
      const providerRequest = {
        state: {
          delegationId: request.input.delegationId,
          taskId: request.input.taskId,
          briefing: request.input.briefing,
          requiredCapabilities: request.input.requiredCapabilities,
        },
        questions: {
          route: choice(
            "Select the best eligible profile. Abstain when no option clearly fits or evidence is uncertain.",
            criteria,
          ),
        },
        model: JEV_MODEL,
      };
      try {
        const result = await withTotalDeadline(
          (signal) =>
            client.systemOne(providerRequest, {
              signal,
              timeout: request.policy.deadlineMs,
              retry: { maxRetries: 0 },
            }),
          request.signal,
          request.policy.deadlineMs,
        );
        return { observation: translateAliases(result, aliases), attempts };
      } catch (error: unknown) {
        if (error instanceof AdvisorTransportError) throw error;
        if (request.signal.aborted || error instanceof APIUserAbortError) {
          throw new AdvisorCancellationError(attempts);
        }
        throw new AdvisorTransportError(guardedFailure ?? "transport_failure", attempts);
      }
    },
  };
}

async function capResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Response> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      if (response.body !== null) void response.body.cancel().catch(() => {});
      throw new AdvisorTransportError("response_limit_exceeded", 1);
    }
  }
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await readWithAbort(reader, signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new AdvisorTransportError("response_limit_exceeded", 1);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  if (signal.aborted) {
    void reader.cancel().catch(() => {});
    throw new AdvisorTransportError("provider_timeout", 1);
  }
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => {
      void reader.cancel().catch(() => {});
      reject(new AdvisorTransportError("provider_timeout", 1));
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (listener !== undefined) signal.removeEventListener("abort", listener);
  }
}

async function withTotalDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) throw new APIUserAbortError();
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new AdvisorTransportError("provider_timeout", 1));
    }, timeoutMs);
    abortListener = () => {
      controller.abort();
      reject(new APIUserAbortError());
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), boundary]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
}

const WireObservationSchema = z
  .object({
    model: z.unknown(),
    answers: z
      .object({
        route: z
          .object({
            type: z.unknown(),
            choice: z.string(),
            confidence: z.unknown(),
            probabilities: z.record(z.string(), z.unknown()),
          })
          .passthrough(),
      })
      .passthrough(),
    usage: z.unknown(),
  })
  .passthrough();

function translateAliases(raw: unknown, aliases: ReadonlyMap<string, string>): unknown {
  const parsed = WireObservationSchema.safeParse(raw);
  if (!parsed.success) return raw;
  const answer = parsed.data.answers.route;
  const translatedChoice =
    answer.choice === WIRE_ABSTAIN_OPTION
      ? ABSTAIN_OPTION
      : (aliases.get(answer.choice) ?? "__invalid_wire_option__");
  const probabilities = Object.fromEntries(
    Object.entries(answer.probabilities).map(([key, value]) => [
      key === WIRE_ABSTAIN_OPTION
        ? ABSTAIN_OPTION
        : (aliases.get(key) ?? `__invalid_wire_option__:${key}`),
      value,
    ]),
  );
  return {
    ...parsed.data,
    answers: {
      ...parsed.data.answers,
      route: { ...answer, choice: translatedChoice, probabilities },
    },
  };
}
