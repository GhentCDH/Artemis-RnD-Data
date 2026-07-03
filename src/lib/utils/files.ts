import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
