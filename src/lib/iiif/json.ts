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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  return Math.min(1000 * 2 ** attempt, 15_000);
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function fetchJson(url: string): Promise<unknown> {
  if (!/^https?:\/\//i.test(url)) {
    return JSON.parse(await readFile(url.replace(/^file:\/\//i, ""), "utf-8")) as unknown;
  }

  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { redirect: "follow", headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    lastStatus = res.status;
    if (!shouldRetryStatus(res.status) || attempt === 4) {
      throw new Error(`Fetch failed (${res.status}) for ${url}`);
    }
    await sleep(retryDelayMs(res, attempt));
  }
  throw new Error(`Fetch failed (${lastStatus ?? "unknown"}) for ${url}`);
}

export async function cachedJson(url: string, cacheDir: string): Promise<unknown> {
  await ensureDir(cacheDir);
  const path = join(cacheDir, `${sha1(url)}.json`);
  if (await pathExists(path)) return JSON.parse(await readFile(path, "utf-8")) as unknown;
  const json = await fetchJson(url);
  await writeFile(path, JSON.stringify(json, null, 2), "utf-8");
  return json;
}

/**
 * Like {@link cachedJson} but always re-fetches so upstream changes are detected
 * (the incremental build hashes this content to decide what to rebuild). The
 * on-disk copy is refreshed on success and used as an offline fallback when the
 * fetch fails. Used for cheap-to-fetch, mutable resources: IIIF collections,
 * manifests, and georeference annotations.
 */
export async function revalidatedJson(url: string, cacheDir: string): Promise<unknown> {
  await ensureDir(cacheDir);
  const path = join(cacheDir, `${sha1(url)}.json`);
  try {
    const json = await fetchJson(url);
    await writeFile(path, JSON.stringify(json, null, 2), "utf-8");
    return json;
  } catch (err) {
    if (await pathExists(path)) return JSON.parse(await readFile(path, "utf-8")) as unknown;
    throw err;
  }
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
