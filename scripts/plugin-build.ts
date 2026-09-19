import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

export const projectRoot = resolve(import.meta.dir, "..");
export const pluginSource = resolve(projectRoot, "plugins/jevbrain");

export async function buildPlugin(): Promise<string> {
  const outputDirectory = resolve(pluginSource, "dist");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve(projectRoot, "src/plugin/server.ts")],
    outdir: outputDirectory,
    target: "bun",
    format: "esm",
    naming: "server.js",
    minify: true,
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log.message}\n`);
    throw new Error("plugin bundle failed");
  }
  return outputDirectory;
}

if (import.meta.main) {
  const outputDirectory = await buildPlugin();
  process.stdout.write(`built ${outputDirectory}\n`);
}
