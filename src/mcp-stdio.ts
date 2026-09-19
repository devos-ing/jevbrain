import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Command } from "commander";
import { z } from "zod";
import { createRoutingMcpServer } from "./route/mcp-server.ts";
import { loadTaskRouter } from "./route/startup.ts";

const OptionsSchema = z.object({ registry: z.string().min(1), policy: z.string().min(1) }).strict();
const program = new Command()
  .name("jevbrain-mcp")
  .requiredOption("--registry <file>", "trusted profile registry JSON")
  .requiredOption("--policy <file>", "trusted routing policy JSON");
program.parse(process.argv);
const rawOptions: unknown = program.opts();
try {
  const options = OptionsSchema.parse(rawOptions);
  const router = await loadTaskRouter(
    options.registry,
    options.policy,
    process.env.TYPESAFE_API_KEY,
  );
  serveStdio(() => createRoutingMcpServer(router), {
    onerror(error) {
      void error;
      process.stderr.write("jevbrain MCP transport error\n");
    },
  });
} catch {
  process.stderr.write("jevbrain MCP startup configuration is invalid\n");
  process.exitCode = 1;
}
