import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { buildPlugin, pluginSource } from "./plugin-build.ts";

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const PluginManifestSchema = z
  .object({ name: z.literal("jevbrain"), version: z.string().min(1) })
  .passthrough();
const MarketplaceEntrySchema = z
  .object({
    name: z.string().min(1),
    source: z.object({ source: z.string(), path: z.string() }).passthrough(),
  })
  .passthrough();
const MarketplaceSchema = z
  .object({
    name: IdentifierSchema,
    interface: z
      .object({ displayName: z.string().min(1) })
      .passthrough()
      .optional(),
    plugins: z.array(z.unknown()),
  })
  .passthrough();
const StageOptionsSchema = z
  .object({
    marketplaceRoot: z.string().min(1),
    marketplaceName: IdentifierSchema,
    cachebuster: z.string().min(1).optional(),
  })
  .strict();

export type StageOptions = z.infer<typeof StageOptionsSchema>;

const pluginEntry = {
  name: "jevbrain",
  source: { source: "local", path: "./plugins/jevbrain" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
} as const;

function defaultCachebuster(): string {
  return `local-${new Date()
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}`;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

export async function assertReplaceablePluginDirectory(destination: string): Promise<void> {
  try {
    const status = await lstat(destination);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`refusing to replace non-directory or symlink: ${destination}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const manifestFile = join(destination, ".codex-plugin/plugin.json");
  try {
    PluginManifestSchema.parse(await readJson(manifestFile));
  } catch {
    throw new Error(`refusing to replace non-Jevbrain plugin directory: ${destination}`);
  }
}

export async function stagePlugin(rawOptions: StageOptions): Promise<{
  marketplaceFile: string;
  pluginDirectory: string;
  version: string;
}> {
  const options = StageOptionsSchema.parse(rawOptions);
  await buildPlugin();
  const marketplaceRoot = resolve(options.marketplaceRoot);
  const marketplaceFile = join(marketplaceRoot, ".agents/plugins/marketplace.json");
  const pluginDirectory = join(marketplaceRoot, "plugins/jevbrain");
  const stageDirectory = join(marketplaceRoot, "plugins", `.jevbrain-stage-${process.pid}`);
  await mkdir(dirname(marketplaceFile), { recursive: true });
  await mkdir(dirname(pluginDirectory), { recursive: true });

  let marketplace: z.infer<typeof MarketplaceSchema> = {
    name: options.marketplaceName,
    interface: {
      displayName: options.marketplaceName === "personal" ? "Personal" : "Jevbrain local",
    },
    plugins: [],
  };
  try {
    marketplace = MarketplaceSchema.parse(await readJson(marketplaceFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (marketplace.name !== options.marketplaceName) {
    throw new Error(
      `marketplace name mismatch: expected ${options.marketplaceName}, found ${marketplace.name}`,
    );
  }

  const namedEntrySchema = z.object({ name: z.string().min(1) }).passthrough();
  const matchingIndexes = marketplace.plugins.flatMap((entry, index) => {
    const parsed = namedEntrySchema.safeParse(entry);
    return parsed.success && parsed.data.name === pluginEntry.name ? [index] : [];
  });
  if (matchingIndexes.length > 1) {
    throw new Error("marketplace contains duplicate jevbrain entries");
  }
  const existingIndex = matchingIndexes[0] ?? -1;
  if (existingIndex >= 0) {
    const existing = MarketplaceEntrySchema.safeParse(marketplace.plugins[existingIndex]);
    if (
      !existing.success ||
      existing.data.source.source !== "local" ||
      existing.data.source.path !== pluginEntry.source.path
    ) {
      throw new Error("existing jevbrain marketplace entry points to a different source");
    }
  }

  await assertReplaceablePluginDirectory(pluginDirectory);
  await rm(stageDirectory, { recursive: true, force: true });
  await cp(pluginSource, stageDirectory, { recursive: true });
  const stagedManifestFile = join(stageDirectory, ".codex-plugin/plugin.json");
  const stagedManifest = PluginManifestSchema.parse(await readJson(stagedManifestFile));
  const baseVersion = stagedManifest.version.split("+")[0] ?? stagedManifest.version;
  const version = `${baseVersion}+codex.${options.cachebuster ?? defaultCachebuster()}`;
  await writeFile(
    stagedManifestFile,
    `${JSON.stringify({ ...stagedManifest, version }, null, 2)}\n`,
  );
  await rm(pluginDirectory, { recursive: true, force: true });
  await rename(stageDirectory, pluginDirectory);

  const plugins = [...marketplace.plugins];
  if (existingIndex >= 0) plugins[existingIndex] = pluginEntry;
  else plugins.push(pluginEntry);
  const nextMarketplace = MarketplaceSchema.parse({ ...marketplace, plugins });
  const temporaryMarketplace = `${marketplaceFile}.tmp-${process.pid}`;
  await writeFile(temporaryMarketplace, `${JSON.stringify(nextMarketplace, null, 2)}\n`);
  await rename(temporaryMarketplace, marketplaceFile);
  return { marketplaceFile, pluginDirectory, version };
}

if (import.meta.main) {
  const program = new Command()
    .name("plugin-stage")
    .description("Build and stage Jevbrain in a personal-style Codex marketplace.")
    .option("--marketplace-root <directory>", "home-style marketplace root", homedir())
    .option("--marketplace-name <name>", "marketplace identifier", "personal");
  program.parse(process.argv);
  const options = StageOptionsSchema.parse(program.opts());
  const staged = await stagePlugin(options);
  process.stdout.write(`${JSON.stringify(staged)}\n`);
}
