import { readJson } from "../benchmark/io.ts";
import { RoutingPolicySchema, RoutingRegistrySchema } from "./contracts.ts";
import { createJevAdvisor } from "./jev-advisor.ts";
import { createTaskRouter } from "./router.ts";

export async function loadTaskRouter(
  registryFile: string,
  policyFile: string,
  apiKey: string | undefined,
) {
  const registry = RoutingRegistrySchema.parse(await readJson(registryFile));
  const policy = RoutingPolicySchema.parse(await readJson(policyFile));
  const advisor =
    apiKey === undefined || apiKey.length === 0 ? undefined : createJevAdvisor({ apiKey });
  return createTaskRouter({
    registry,
    policy,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(advisor === undefined ? {} : { advisor }),
  });
}
