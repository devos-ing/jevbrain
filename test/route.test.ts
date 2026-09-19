import { describe, expect, test } from "bun:test";
import type { Fetch } from "@typesafe-ai/sdk";
import { z } from "zod";
import { createJevAdvisor, JEV_MODEL, TYPESAFE_SYSTEM_ONE_URL } from "../src/route/jev-advisor.ts";
import { createTaskRouter } from "../src/route/router.ts";

const registry = {
  registryVersion: "1.0.0",
  profiles: [
    {
      profileId: "coder",
      profileVersion: "1.0.0",
      role: "Implementation engineer",
      description: "Implements bounded TypeScript changes.",
      runtime: "codex-cli",
      model: "gpt-test",
      capabilities: ["typescript", "tests"],
      enabled: true,
      declaredAvailable: true,
    },
    {
      profileId: "disabled",
      profileVersion: "1.0.0",
      role: "Disabled engineer",
      description: "Synthetic disabled profile.",
      runtime: "claude-code",
      model: "claude-test",
      capabilities: ["typescript"],
      enabled: false,
      declaredAvailable: true,
    },
  ],
};

const policy = {
  policyVersion: "1.0.0",
  allowedProfileIds: ["coder", "disabled"],
  providerEnabled: true,
  egressEnabled: true,
  confidenceThreshold: 0.7,
  deadlineMs: 100,
  maxRequestBytes: 16_384,
  maxResponseBytes: 16_384,
};

const request = {
  delegationId: "delegation-1",
  taskId: "task-1",
  contextStatus: "ready",
  briefing: {
    objective: "Implement the approved routing slice.",
    acceptanceCriteria: ["Focused tests pass."],
    constraints: ["No worker execution."],
    decisions: ["Use Bun."],
  },
  requiredCapabilities: ["typescript"],
};

function response(choice: string, confidence = 0.9): Response {
  return Response.json({
    model: JEV_MODEL,
    answers: {
      route: {
        type: "choice",
        choice,
        confidence,
        probabilities: { option_1: 0.9, option_abstain: 0.1 },
      },
    },
    usage: { input_tokens: 20, output_tokens: 4 },
  });
}

describe("task routing", () => {
  test("filters trusted eligibility and treats an empty candidate list as no target", async () => {
    let calls = 0;
    const adapter = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: async () => {
        calls += 1;
        return response("option_1");
      },
    });
    const router = createTaskRouter({
      registry,
      policy,
      apiKey: "synthetic-test-key",
      advisor: adapter,
    });
    const empty = await router(
      { ...request, candidateProfileIds: [] },
      new AbortController().signal,
    );
    const disabled = await router(
      { ...request, candidateProfileIds: ["disabled"] },
      new AbortController().signal,
    );
    expect(empty.status).toBe("no_eligible_target");
    expect(disabled.status).toBe("no_eligible_target");
    expect(calls).toBe(0);
  });

  test("gates context, provider opt-in, and credentials before HTTP", async () => {
    const contextRouter = createTaskRouter({ registry, policy });
    const preCancelledController = new AbortController();
    preCancelledController.abort();
    const preCancelled = await contextRouter(request, preCancelledController.signal);
    const missingContext = await contextRouter(
      { ...request, contextStatus: "needs_context" },
      new AbortController().signal,
    );
    const noKey = await contextRouter(request, new AbortController().signal);
    const offRouter = createTaskRouter({
      registry,
      policy: { ...policy, egressEnabled: false },
      apiKey: "unused",
    });
    const off = await offRouter(request, new AbortController().signal);
    expect(missingContext.status).toBe("needs_context");
    expect(noKey.status === "abstained" && noKey.reason).toBe("credentials_unavailable");
    expect(off.status === "abstained" && off.reason).toBe("provider_disabled");
    expect(preCancelled.status).toBe("cancelled");
    expect(preCancelled.metadata.attempts).toBe(0);
    expect(missingContext.metadata.attempts + noKey.metadata.attempts + off.metadata.attempts).toBe(
      0,
    );
  });

  test("uses official SDK serialization for one selected or abstained choice", async () => {
    const BodySchema = z.object({
      model: z.literal(JEV_MODEL),
      questions: z.object({ route: z.object({ type: z.literal("choice") }) }),
    });
    let observedBody: unknown;
    let calls = 0;
    const sdkFetch: Fetch = async (input, init) => {
      calls += 1;
      expect(input).toBe(TYPESAFE_SYSTEM_ONE_URL);
      expect(init?.redirect).toBe("error");
      observedBody = JSON.parse(typeof init?.body === "string" ? init.body : "") as unknown;
      return response("option_1");
    };
    const advisor = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: sdkFetch,
    });
    const router = createTaskRouter({ registry, policy, apiKey: "synthetic-test-key", advisor });
    const selected = await router(request, new AbortController().signal);
    expect(selected.status).toBe("selected");
    expect(selected.metadata.attempts).toBe(1);
    expect(calls).toBe(1);
    expect(BodySchema.parse(observedBody).model).toBe(JEV_MODEL);
  });

  test("rejects malformed choice shapes and low confidence", async () => {
    const malformedAdvisor = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: async () =>
        Response.json({
          model: JEV_MODEL,
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    const malformedRouter = createTaskRouter({
      registry,
      policy,
      apiKey: "synthetic-test-key",
      advisor: malformedAdvisor,
    });
    const malformed = await malformedRouter(request, new AbortController().signal);
    const lowAdvisor = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: async () => response("option_1", 0.5),
    });
    const lowRouter = createTaskRouter({
      registry,
      policy,
      apiKey: "synthetic-test-key",
      advisor: lowAdvisor,
    });
    const low = await lowRouter(request, new AbortController().signal);
    expect(malformed.status === "abstained" && malformed.reason).toBe("invalid_provider_response");
    expect(low.status === "abstained" && low.reason).toBe("confidence_below_threshold");
  });

  test("does not retry 429 responses and enforces response limits", async () => {
    let calls = 0;
    const rateLimited = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: async () => {
        calls += 1;
        return new Response("limited", { status: 429 });
      },
    });
    const rateRouter = createTaskRouter({
      registry,
      policy,
      apiKey: "synthetic-test-key",
      advisor: rateLimited,
    });
    const failed = await rateRouter(request, new AbortController().signal);
    expect(failed.status === "abstained" && failed.reason).toBe("transport_failure");
    expect(calls).toBe(1);

    const oversized = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: async () => new Response("x".repeat(2_000), { headers: { "content-length": "2000" } }),
    });
    const limitRouter = createTaskRouter({
      registry,
      policy: { ...policy, maxResponseBytes: 1_024 },
      apiKey: "synthetic-test-key",
      advisor: oversized,
    });
    const limited = await limitRouter(request, new AbortController().signal);
    expect(limited.status === "abstained" && limited.reason).toBe("response_limit_exceeded");
  });

  test("rejects an oversized serialized request before transport", async () => {
    let calls = 0;
    const advisor = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: async () => {
        calls += 1;
        return response("option_1");
      },
    });
    const router = createTaskRouter({
      registry,
      policy: { ...policy, maxRequestBytes: 1_024 },
      apiKey: "synthetic-test-key",
      advisor,
    });
    const outcome = await router(
      {
        ...request,
        briefing: { ...request.briefing, objective: "x".repeat(2_000) },
      },
      new AbortController().signal,
    );
    expect(outcome.status === "abstained" && outcome.reason).toBe("request_limit_exceeded");
    expect(outcome.metadata.attempts).toBe(0);
    expect(calls).toBe(0);
  });

  test("caps an undeclared response stream and cancels a stalled stream", async () => {
    let oversizedCancelled = false;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(800));
        controller.enqueue(new Uint8Array(800));
      },
      cancel() {
        oversizedCancelled = true;
      },
    });
    const oversizedAdvisor = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: async () => new Response(oversizedStream),
    });
    const oversizedRouter = createTaskRouter({
      registry,
      policy: { ...policy, maxResponseBytes: 1_024 },
      apiKey: "synthetic-test-key",
      advisor: oversizedAdvisor,
    });
    const oversized = await oversizedRouter(request, new AbortController().signal);
    expect(oversized.status === "abstained" && oversized.reason).toBe("response_limit_exceeded");
    expect(oversizedCancelled).toBe(true);

    let stalledCancelled = false;
    const stalledAdvisor = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              stalledCancelled = true;
            },
          }),
        ),
    });
    const stalledRouter = createTaskRouter({
      registry,
      policy: { ...policy, deadlineMs: 50 },
      apiKey: "synthetic-test-key",
      advisor: stalledAdvisor,
    });
    const stalled = await stalledRouter(request, new AbortController().signal);
    expect(stalled.status === "abstained" && stalled.reason).toBe("provider_timeout");
    await Bun.sleep(0);
    expect(stalledCancelled).toBe(true);
  });

  test("caller cancellation after transport success wins before result publication", async () => {
    const controller = new AbortController();
    const advisor = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: async () => {
        controller.abort();
        return response("option_1");
      },
    });
    const router = createTaskRouter({
      registry,
      policy,
      apiKey: "synthetic-test-key",
      advisor,
    });
    const outcome = await router(request, controller.signal);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.metadata.attempts).toBe(1);
  });

  test("settles deadline and caller cancellation when fetch ignores abort", async () => {
    const neverFetch: Fetch = () => new Promise<Response>(() => {});
    const deadlineAdvisor = createJevAdvisor({
      apiKey: "synthetic-test-key",
      transportMode: "replay",
      fetch: neverFetch,
    });
    const deadlineRouter = createTaskRouter({
      registry,
      policy: { ...policy, deadlineMs: 50 },
      apiKey: "synthetic-test-key",
      advisor: deadlineAdvisor,
    });
    const started = performance.now();
    const timedOut = await deadlineRouter(request, new AbortController().signal);
    expect(timedOut.status === "abstained" && timedOut.reason).toBe("provider_timeout");
    expect(performance.now() - started).toBeLessThan(500);

    const controller = new AbortController();
    const cancellation = deadlineRouter(request, controller.signal);
    controller.abort();
    const cancelled = await cancellation;
    expect(cancelled.status).toBe("cancelled");
  });
});
