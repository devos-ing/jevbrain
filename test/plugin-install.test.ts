import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { assertReplaceablePluginDirectory, stagePlugin } from "../scripts/plugin-stage.ts";
import { RoutingOptionsResultSchema } from "../src/route/contracts.ts";

const TextResultSchema = z
  .object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()).min(1),
  })
  .passthrough();

test("staging refuses an unrelated plugin directory without deleting its files", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-plugin-collision-"));
  const destination = join(root, "plugins/jevbrain");
  const sentinel = join(destination, "sentinel.txt");
  try {
    await mkdir(destination, { recursive: true });
    await writeFile(sentinel, "keep me\n");
    await expect(assertReplaceablePluginDirectory(destination)).rejects.toThrow(
      "refusing to replace non-Jevbrain plugin directory",
    );
    expect(await readFile(sentinel, "utf8")).toBe("keep me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staged plugin preserves the marketplace and serves default-off MCP tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevbrain-plugin-install-"));
  const marketplaceFile = join(root, ".agents/plugins/marketplace.json");
  const configDirectory = join(root, "host-config");
  let client: Client | undefined;
  try {
    await mkdir(join(root, ".agents/plugins"), { recursive: true });
    await writeFile(
      marketplaceFile,
      `${JSON.stringify(
        {
          name: "jevbrain-local",
          interface: { displayName: "Local test", retained: true },
          plugins: [
            {
              name: "existing-plugin",
              source: { source: "local", path: "./plugins/existing-plugin" },
              policy: { installation: "AVAILABLE", authentication: "ON_USE" },
              category: "Productivity",
              retained: true,
            },
          ],
          retainedRoot: true,
        },
        null,
        2,
      )}\n`,
    );
    const staged = await stagePlugin({
      marketplaceRoot: root,
      marketplaceName: "jevbrain-local",
      cachebuster: "test",
    });
    expect(staged.version).toBe("0.1.0+codex.test");
    const marketplace = z
      .object({
        retainedRoot: z.literal(true),
        interface: z.object({ retained: z.literal(true) }).passthrough(),
        plugins: z.array(z.object({ name: z.string() }).passthrough()),
      })
      .passthrough()
      .parse(JSON.parse(await readFile(marketplaceFile, "utf8")) as unknown);
    expect(marketplace.plugins.map(({ name }) => name)).toEqual(["existing-plugin", "jevbrain"]);
    const bundle = await readFile(join(staged.pluginDirectory, "dist/server.js"), "utf8");
    expect(bundle).not.toContain("/Users/roy");
    expect(bundle).not.toContain("../src/");

    await mkdir(configDirectory);
    const registryFile = join(configDirectory, "registry.json");
    const policyFile = join(configDirectory, "policy.json");
    await writeFile(
      registryFile,
      JSON.stringify({
        registryVersion: "1.0.0",
        profiles: [
          {
            profileId: "general-medium",
            profileVersion: "1.0.0",
            role: "General implementation",
            description: "Available only for the isolated plugin smoke.",
            runtime: "codex-cli",
            model: "gpt-5.6-sol",
            effort: "medium",
            capabilities: ["implementation", "typescript"],
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
        allowedProfileIds: ["general-medium"],
        providerEnabled: false,
        egressEnabled: false,
        confidenceThreshold: 0.7,
        deadlineMs: 1_800_000,
        maxRequestBytes: 16_384,
        maxResponseBytes: 65_536,
      }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(staged.pluginDirectory, "dist/server.js")],
      cwd: staged.pluginDirectory,
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: root,
        NO_COLOR: "1",
        JEVBRAIN_REGISTRY: registryFile,
        JEVBRAIN_POLICY: policyFile,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "jevbrain-plugin-test", version: "1.0.0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "task_route",
      "task_route_options",
    ]);
    const optionsResult = await client.callTool(
      { name: "task_route_options", arguments: {} },
      { timeout: 1_800_000 },
    );
    const optionsText = TextResultSchema.parse(optionsResult).content[0]?.text;
    const options = RoutingOptionsResultSchema.parse(JSON.parse(optionsText ?? "") as unknown);
    expect(options.profiles).toHaveLength(1);
    expect(options.profiles[0]).toMatchObject({ profileId: "general-medium", effort: "medium" });

    const routeResult = await client.callTool(
      {
        name: "task_route",
        arguments: {
          delegationId: "plugin-test-delegation",
          taskId: "plugin-test-task",
          contextStatus: "ready",
          briefing: {
            objective: "Verify the installed default-off plugin.",
            acceptanceCriteria: ["Return without provider egress."],
            constraints: [],
            decisions: [],
          },
          requiredCapabilities: ["typescript"],
        },
      },
      { timeout: 1_800_000 },
    );
    const routeText = TextResultSchema.parse(routeResult).content[0]?.text;
    expect(JSON.parse(routeText ?? "") as unknown).toMatchObject({
      status: "abstained",
      reason: "provider_disabled",
    });
  } finally {
    await client?.close();
    await rm(root, { recursive: true, force: true });
  }
});
