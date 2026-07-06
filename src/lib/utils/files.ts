import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { brotliBuffer } from "./compress";

export function writePlainJsonEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.WRITE_PLAIN_JSON ?? "");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** SHA-256 of a file's bytes (content-based, so it is stable across machines/checkouts). */
export async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** True if `path` exists as a file (unlike `pathExists`, which tests a directory). */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True only if every path exists. Empty list is trivially true. */
export async function allExist(paths: string[]): Promise<boolean> {
  const results = await Promise.all(paths.map(fileExists));
  return results.every(Boolean);
}

export async function writeJson(path: string, value: unknown, pretty = false): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, "utf-8");
}

export async function writeJsonWithBrotli(path: string, value: unknown, pretty = false): Promise<void> {
  await ensureDir(dirname(path));
  const content = `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
  await writeFile(`${path}.br`, await brotliBuffer(content));
  if (writePlainJsonEnabled()) await writeFile(path, content, "utf-8");
  else await Bun.file(path).delete().catch(() => {});
}

export async function writeJsonBrotliOnly(path: string, value: unknown, pretty = false): Promise<void> {
  await ensureDir(dirname(path));
  const content = `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
  await writeFile(`${path}.br`, await brotliBuffer(content));
}

export async function readJsonFile<T>(path: string): Promise<T> {
  let content = await readFile(path, "utf-8");
  content = content.replace(/:\s*NaN(?=[,}\]])/g, ": null");
  return JSON.parse(content) as T;
}

export async function listFiles(dir: string, pattern: RegExp): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
