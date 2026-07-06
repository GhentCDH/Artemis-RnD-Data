import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { unzipSync } from "fflate";
import { BUILD_CACHE_DIR } from "../paths";
import { log } from "../log";
import { ensureDir, fileExists } from "../utils/files";

type ZenodoRecord = {
  id: number;
  files?: Array<{
    key: string;
    size: number;
    checksum?: string;
    links?: {
      self?: string;
    };
  }>;
};

export type ZenodoSourceSyncResult = {
  recordId: string;
  sourceDir: string;
  zipPath: string;
  checksum: string;
  size: number;
};

const DEFAULT_SOURCE_ZIP = "Source.zip";
const MIRROR_MANIFEST = ".zenodo-source.json";

function zenodoRecordApiUrl(recordId: string): string {
  if (!/^\d+$/.test(recordId)) throw new Error(`Zenodo record id must be numeric, got '${recordId}'`);
  return `https://zenodo.org/api/records/${recordId}`;
}

function md5File(path: string): Promise<string> {
  return readFile(path).then((buffer) => createHash("md5").update(buffer).digest("hex"));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Zenodo API request failed (${res.status} ${res.statusText}): ${url}`);
  return await res.json() as T;
}

async function downloadFile(url: string, path: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Zenodo file download failed (${res.status} ${res.statusText}): ${url}`);
  const body = await res.arrayBuffer();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, body);
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
  const files = unzipSync(new Uint8Array(await readFile(zipPath)));
  const normalizedDestination = normalize(destination);
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    const outputPath = normalize(join(destination, name));
    if (outputPath !== normalizedDestination && !outputPath.startsWith(`${normalizedDestination}${sep}`)) {
      throw new Error(`Refusing to extract unsafe ZIP path: ${name}`);
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content);
  }
}

export async function syncZenodoSource(recordId: string, fileName = DEFAULT_SOURCE_ZIP): Promise<ZenodoSourceSyncResult> {
  log.step(`Syncing Zenodo source record ${recordId}`);

  const record = await fetchJson<ZenodoRecord>(zenodoRecordApiUrl(recordId));
  const file = record.files?.find((item) => item.key === fileName);
  if (!file) throw new Error(`Zenodo record ${recordId} does not contain ${fileName}`);
  if (!file.links?.self) throw new Error(`Zenodo record ${recordId} file ${fileName} has no download URL`);

  const root = join(BUILD_CACHE_DIR, "zenodo-source", recordId);
  const zipPath = join(root, fileName);
  const sourceDir = join(root, "Source");
  const manifestPath = join(sourceDir, MIRROR_MANIFEST);
  const expectedMd5 = file.checksum?.startsWith("md5:") ? file.checksum.slice("md5:".length) : undefined;

  let downloaded = false;
  if (!await fileExists(zipPath) || (expectedMd5 && await md5File(zipPath) !== expectedMd5)) {
    log.info(`  downloading ${fileName} (${file.size.toLocaleString()} bytes)`);
    await downloadFile(file.links.self, zipPath);
    downloaded = true;
  }

  const actualMd5 = await md5File(zipPath);
  if (expectedMd5 && actualMd5 !== expectedMd5) {
    throw new Error(`Zenodo checksum mismatch for ${fileName}: expected ${expectedMd5}, got ${actualMd5}`);
  }

  if (await fileExists(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    if (manifest.recordId === recordId && manifest.fileName === fileName && manifest.checksum === actualMd5 && manifest.size === file.size) {
      log.ok(`${fileName} already mirrored and verified`);
      log.ok(`source mirror: ${sourceDir}`);
      return {
        recordId,
        sourceDir,
        zipPath,
        checksum: expectedMd5 ?? actualMd5,
        size: file.size,
      };
    }
  }

  await rm(sourceDir, { recursive: true, force: true });
  await ensureDir(sourceDir);
  await extractZip(zipPath, sourceDir);
  await writeFile(
    manifestPath,
    `${JSON.stringify({ recordId, fileName, checksum: actualMd5, size: file.size, mirroredAt: new Date().toISOString() }, null, 2)}\n`,
    "utf-8",
  );

  log.ok(`${downloaded ? "downloaded and extracted" : "verified and extracted"} ${fileName}`);
  log.ok(`source mirror: ${sourceDir}`);

  return {
    recordId,
    sourceDir,
    zipPath,
    checksum: expectedMd5 ?? actualMd5,
    size: file.size,
  };
}
