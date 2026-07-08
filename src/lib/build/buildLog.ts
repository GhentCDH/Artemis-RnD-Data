import { appendFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir } from "../utils/files";

export const BUILD_LOG_PATH = "build/Build.log";
export const IIIF_WARNINGS_LOG_PATH = "build/IIIFWarnings.log";
export const DOWNLOAD_WARNINGS_LOG_PATH = "build/DownloadWarnings.log";

export class BuildLog {
  private sectionOpen = false;

  constructor(private readonly path = BUILD_LOG_PATH, private readonly title = "Artemis Data Build Log") {}

  async reset(command: string, args: string[]): Promise<void> {
    await ensureDir(dirname(this.path));
    await writeFile(
      this.path,
      [
        this.title,
        "=".repeat(this.title.length),
        "",
        `Started  ${new Date().toISOString()}`,
        `Command  ${command}${args.length > 0 ? ` ${args.join(" ")}` : ""}`,
        "",
      ].join("\n"),
      "utf-8",
    );
    this.sectionOpen = false;
  }

  async info(message: string): Promise<void> {
    await appendFile(this.path, `${message}\n`, "utf-8");
  }

  async blank(): Promise<void> {
    await appendFile(this.path, "\n", "utf-8");
  }

  async section(title: string): Promise<void> {
    if (this.sectionOpen) await this.blank();
    await appendFile(this.path, `${title}\n${"-".repeat(title.length)}\n`, "utf-8");
    this.sectionOpen = true;
  }

  async fields(fields: Record<string, string | number | undefined>): Promise<void> {
    const entries = Object.entries(fields).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
    if (entries.length === 0) return;
    const width = Math.max(...entries.map(([key]) => key.length));
    await appendFile(
      this.path,
      `${entries.map(([key, value]) => `  ${key.padEnd(width)}  ${value}`).join("\n")}\n`,
      "utf-8",
    );
  }

  async error(message: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await this.section("Error");
    await this.fields({ step: message, detail });
  }

  async timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const result = await fn();
      await this.fields({ [`${label} duration`]: formatDuration(performance.now() - started) });
      return result;
    } catch (error) {
      await this.error(label, error);
      await this.fields({ [`${label} duration`]: formatDuration(performance.now() - started) });
      throw error;
    }
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}
