import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RoutingOptionsResultSchema, TaskRouteResultSchema } from "../src/route/contracts.ts";
import { createRoutingMcpServer } from "../src/route/mcp-server.ts";

const TextResultSchema = z
  .object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()).min(1),
  })
  .passthrough();

const testRouter = (
  handler: Parameters<typeof createRoutingMcpServer>[0] extends infer Router
    ? Router extends (...args: infer Args) => infer Result
      ? (...args: Args) => Result
      : never
    : never,
): Parameters<typeof createRoutingMcpServer>[0] =>
  Object.assign(handler, {
    listOptions: () =>
      RoutingOptionsResultSchema.parse({
        schemaVersion: "routing-options-v1",
        registryVersion: "1.0.0",
        policyVersion: "1.0.0",
        profiles: [],
      }),
  });

test("official MCP client lists routing and read-only options tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevbrain-mcp-test-"));
  const registryFile = join(directory, "registry.json");
  const policyFile = join(directory, "policy.json");
  await writeFile(
    registryFile,
    JSON.stringify({
      registryVersion: "1.0.0",
      profiles: [
        {
          profileId: "coder",
          profileVersion: "1.0.0",
          role: "Synthetic coder",
          description: "A synthetic test-only profile.",
          runtime: "codex-cli",
          model: "gpt-test",
          capabilities: ["typescript"],
          enabled: true,
          declaredAvailable: true,
        },
      ],
    }),
  );
  await writeFile(
    policyFile,
    JSON.stringify({
      policyVersion: "1.0.0",
      allowedProfileIds: ["coder"],
      providerEnabled: false,
      egressEnabled: false,
      confidenceThreshold: 0.7,
      deadlineMs: 500,
      maxRequestBytes: 16_384,
      maxResponseBytes: 16_384,
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(import.meta.dir, "../bin/jevbrain.mjs"),
      "server",
      "--registry",
      registryFile,
      "--policy",
      policyFile,
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "jevbrain-test-client", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(["task_route", "task_route_options"]);
    const advertisedSchema = z
      .object({
        type: z.literal("object"),
        properties: z.record(z.string(), z.unknown()),
        required: z.array(z.string()),
      })
      .passthrough()
      .parse(listed.tools[0]?.inputSchema);
    expect(advertisedSchema.required).toContain("delegationId");
    expect(advertisedSchema.properties).toHaveProperty("briefing");
    const optionsResult = await client.callTool({
      name: "task_route_options",
      arguments: {},
    });
    const optionsText = TextResultSchema.parse(optionsResult).content[0]?.text;
    expect(RoutingOptionsResultSchema.parse(JSON.parse(optionsText ?? "")).profiles).toEqual([
      {
        profileId: "coder",
        profileVersion: "1.0.0",
        role: "Synthetic coder",
        description: "A synthetic test-only profile.",
        runtime: "codex-cli",
        model: "gpt-test",
        capabilities: ["typescript"],
      },
    ]);
    const invalid = await client.callTool({
      name: "task_route",
      arguments: {
        delegationId: "delegation-1",
        PRIVATE_SCHEMA_CANARY: "PRIVATE_SCHEMA_CANARY",
      },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain("PRIVATE_SCHEMA_CANARY");
    expect(JSON.stringify(invalid)).toContain("Invalid routing request");
    const result = await client.callTool({
      name: "task_route",
      arguments: {
        delegationId: "delegation-1",
        taskId: "task-1",
        contextStatus: "ready",
        briefing: {
          objective: "Select a synthetic profile.",
          acceptanceCriteria: ["Return safely without egress."],
          constraints: [],
          decisions: [],
        },
        requiredCapabilities: ["typescript"],
      },
    });
    const text = TextResultSchema.parse(result).content[0]?.text;
    const outcome = z
      .object({ status: z.literal("abstained"), reason: z.literal("provider_disabled") })
      .passthrough()
      .parse(JSON.parse(text ?? "") as unknown);
    expect(outcome.reason).toBe("provider_disabled");
    expect("structuredContent" in result).toBe(false);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP handler failures return a fixed non-leaking tool error", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createRoutingMcpServer(
    testRouter(async () => {
      throw new Error("PRIVATE_HANDLER_CANARY");
    }),
  );
  const client = new Client({ name: "jevbrain-error-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "task_route",
      arguments: {
        delegationId: "delegation-1",
        taskId: "task-1",
        contextStatus: "ready",
        briefing: {
          objective: "Exercise fixed MCP errors.",
          acceptanceCriteria: ["No private handler error is exposed."],
          constraints: [],
          decisions: [],
        },
        requiredCapabilities: [],
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_HANDLER_CANARY");
    expect(JSON.stringify(result)).toContain("routing_failed");
  } finally {
    await client.close();
    await server.close();
  }
});

test("official client cancellation reaches the active tool and suppresses a normal result", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let handlerCancelled = false;
  const handlerStarted = Promise.withResolvers<void>();
  const server = createRoutingMcpServer(
    testRouter(
      async (_input, signal) =>
        new Promise((resolve) => {
          handlerStarted.resolve();
          signal.addEventListener(
            "abort",
            () => {
              handlerCancelled = true;
              resolve(
                TaskRouteResultSchema.parse({
                  schemaVersion: "routing-v1",
                  status: "cancelled",
                  reason: "caller_cancelled",
                  binding: {
                    delegationId: "delegation-1",
                    taskId: "task-1",
                    inputDigest: `sha256:${"0".repeat(64)}`,
                    registryVersion: "1.0.0",
                    registryDigest: `sha256:${"0".repeat(64)}`,
                    policyVersion: "1.0.0",
                    policyDigest: `sha256:${"0".repeat(64)}`,
                  },
                  metadata: { attempts: 0, elapsedMs: 0, transportMode: "disabled" },
                }),
              );
            },
            { once: true },
          );
        }),
    ),
  );
  const client = new Client({ name: "jevbrain-cancel-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const controller = new AbortController();
    const call = client.callTool(
      {
        name: "task_route",
        arguments: {
          delegationId: "delegation-1",
          taskId: "task-1",
          contextStatus: "ready",
          briefing: {
            objective: "Cancel this request.",
            acceptanceCriteria: ["Cancellation reaches the handler."],
            constraints: [],
            decisions: [],
          },
          requiredCapabilities: [],
        },
      },
      { signal: controller.signal },
    );
    await handlerStarted.promise;
    controller.abort();
    await expect(call).rejects.toThrow();
    await Bun.sleep(0);
    expect(handlerCancelled).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
