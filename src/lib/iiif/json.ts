import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../utils/files";

export function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function fetchJson(url: string): Promise<unknown> {
  if (!/^https?:\/\//i.test(url)) {
    return JSON.parse(await readFile(url.replace(/^file:\/\//i, ""), "utf-8")) as unknown;
  }

  const res = await fetch(url, { redirect: "follow", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return res.json();
}

export async function cachedJson(url: string, cacheDir: string): Promise<unknown> {
  await ensureDir(cacheDir);
  const path = join(cacheDir, `${sha1(url)}.json`);
  if (await pathExists(path)) return JSON.parse(await readFile(path, "utf-8")) as unknown;
  const json = await fetchJson(url);
  await writeFile(path, JSON.stringify(json, null, 2), "utf-8");
  return json;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
