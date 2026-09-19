import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { z } from "zod";

export function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function digestJson(value: unknown): `sha256:${string}` {
  return digest(JSON.stringify(canonicalize(value)));
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function readJsonLines(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export function parseAll<T>(schema: z.ZodType<T>, values: readonly unknown[]): T[] {
  return values.map((value) => schema.parse(value));
}
