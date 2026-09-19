import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RoutingErrorSchema, type TaskRouteInput, TaskRouteInputSchema } from "./contracts.ts";
import type { TaskRouter } from "./router.ts";

const SafeTaskRouteInputSchema: StandardSchemaWithJSON<unknown, TaskRouteInput> = {
  "~standard": {
    ...TaskRouteInputSchema["~standard"],
    validate(value: unknown) {
      const parsed = TaskRouteInputSchema.safeParse(value);
      if (parsed.success) return { value: parsed.data };
      return { issues: [{ message: "Invalid routing request" }] };
    },
  },
};

export function createRoutingMcpServer(router: TaskRouter): McpServer {
  const server = new McpServer(
    { name: "jevbrain", version: "0.0.1" },
    {
      capabilities: { tools: {} },
      instructions:
        "The main session has already decided to delegate. task_route_options lists currently available trusted profiles without provider access. task_route selects an eligible registered sub-agent profile. The host separately launches that profile; this server never executes workers.",
    },
  );
  server.registerTool(
    "task_route",
    {
      title: "Select a registered sub-agent profile",
      description:
        "Select one eligible profile for an already-approved delegation. Candidate IDs can only narrow trusted startup policy. This does not launch a worker or verify runtime permissions.",
      inputSchema: SafeTaskRouteInputSchema,
    },
    async (input, context) => {
      try {
        const result = await router(input, context.mcpReq.signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch {
        const error = RoutingErrorSchema.parse({ status: "error", reason: "routing_failed" });
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(error) }],
        };
      }
    },
  );
  server.registerTool(
    "task_route_options",
    {
      title: "List available registered sub-agent profiles",
      description:
        "List trusted profiles that are enabled, declared available, and allowed by startup policy. This does not call a provider, route a task, or launch a worker.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const result = router.listOptions();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
  return server;
}
