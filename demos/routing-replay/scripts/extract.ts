import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReplayDataSchema } from "../src/contracts.ts";
import { illustrativeReplay } from "../src/fixture.ts";

const outputDirectory = join(import.meta.dir, "../public/data");

export function getReplayData(): unknown {
  return ReplayDataSchema.parse(illustrativeReplay);
}

if (import.meta.main) {
  await mkdir(outputDirectory, { recursive: true });
  const data = getReplayData();
  await writeFile(join(outputDirectory, "replay.json"), `${JSON.stringify(data, null, 2)}\n`);
  console.log("wrote illustrative routing replay");
}
