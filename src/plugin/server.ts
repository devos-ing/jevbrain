import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createRoutingMcpServer } from "../route/mcp-server.ts";
import { loadTaskRouter } from "../route/startup.ts";

const pluginRoot = resolve(import.meta.dir, "..");
const OptionalEnvironmentValueSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const EnvironmentSchema = z
  .object({
    JEVBRAIN_REGISTRY: OptionalEnvironmentValueSchema,
    JEVBRAIN_POLICY: OptionalEnvironmentValueSchema,
    TYPESAFE_API_KEY: OptionalEnvironmentValueSchema,
  })
  .passthrough();

try {
  const environment = EnvironmentSchema.parse(process.env);
  const registryFile = environment.JEVBRAIN_REGISTRY ?? resolve(pluginRoot, "config/registry.json");
  const policyFile = environment.JEVBRAIN_POLICY ?? resolve(pluginRoot, "config/policy.json");
  const router = await loadTaskRouter(registryFile, policyFile, environment.TYPESAFE_API_KEY);
  serveStdio(() => createRoutingMcpServer(router), {
    onerror(error) {
      void error;
      process.stderr.write("jevbrain plugin MCP transport error\n");
    },
  });
} catch {
  process.stderr.write("jevbrain plugin startup configuration is invalid\n");
  process.exitCode = 1;
}
