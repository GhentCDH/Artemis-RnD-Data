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

// Zenodo runs on InvenioRDM: a "new version" draft (Zenodo's "New version"
// button, as opposed to "Edit") is a genuinely separate record with its own
// numeric id (visible in its zenodo.org/uploads/<id> URL) - there is no
// reliable, documented way to discover that id starting only from the
// published record id. Verified live: `/api/records/<publishedId>/draft`
// returns an in-place *metadata-edit* draft of that same id (unrelated,
// unchanged files), and `/api/records/<publishedId>/versions` only indexes
// published versions, never the pending draft. So callers must pass the
// draft's own id directly (isDraft just changes which API/auth is used to
// read it), not the id of whatever it was versioned from.
type ZenodoDraftFileEntry = {
  key: string;
  size?: number;
  checksum?: string;
};

type ZenodoDraftFiles = {
  entries?: ZenodoDraftFileEntry[];
};

export type ZenodoSourceSyncResult = {
  recordId: string;
  sourceDir: string;
  zipPath: string;
  checksum: string;
  size: number;
};

export type ZenodoSourceOptions = {
  /** Treat recordId as an unpublished draft's own id (not a published record id) and read it via the draft API. */
  isDraft?: boolean;
  /** Required when isDraft is true - viewing an unpublished draft requires ownership auth. */
  token?: string;
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

async function fetchJson<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Zenodo API request failed (${res.status} ${res.statusText}): ${url}`);
  return await res.json() as T;
}

async function downloadFile(url: string, path: string, token?: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Zenodo file download failed (${res.status} ${res.statusText}): ${url}`);
  const body = await res.arrayBuffer();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, body);
}

/** List the files in an unpublished draft, given the draft's own record id. */
export async function listDraftFiles(draftId: string, token: string): Promise<ZenodoDraftFileEntry[]> {
  const listing = await fetchJson<ZenodoDraftFiles>(`https://zenodo.org/api/records/${draftId}/draft/files`, token);
  return listing.entries ?? [];
}

function zenodoDraftFileContentUrl(draftId: string, fileName: string): string {
  return `https://zenodo.org/api/records/${draftId}/draft/files/${encodeURIComponent(fileName)}/content`;
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

export async function syncZenodoSource(
  recordId: string,
  options: ZenodoSourceOptions = {},
  fileName = DEFAULT_SOURCE_ZIP,
): Promise<ZenodoSourceSyncResult> {
  const { isDraft = false, token } = options;
  log.step(`Syncing Zenodo source record ${recordId}${isDraft ? " (draft)" : ""}`);

  let downloadUrl: string;
  let size: number;
  let checksum: string | undefined;

  if (isDraft) {
    if (!token) throw new Error("ZENODO_TOKEN is required to read from an unpublished draft");
    const files = await listDraftFiles(recordId, token);
    const file = files.find((item) => item.key === fileName);
    if (!file) throw new Error(`Zenodo draft ${recordId} does not contain ${fileName}`);
    downloadUrl = zenodoDraftFileContentUrl(recordId, fileName);
    size = file.size ?? 0;
    checksum = file.checksum;
  } else {
    const record = await fetchJson<ZenodoRecord>(zenodoRecordApiUrl(recordId));
    const file = record.files?.find((item) => item.key === fileName);
    if (!file) throw new Error(`Zenodo record ${recordId} does not contain ${fileName}`);
    if (!file.links?.self) throw new Error(`Zenodo record ${recordId} file ${fileName} has no download URL`);
    downloadUrl = file.links.self;
    size = file.size;
    checksum = file.checksum;
  }

  const root = join(BUILD_CACHE_DIR, "zenodo-source", recordId);
  const zipPath = join(root, fileName);
  const sourceDir = join(root, "Source");
  const manifestPath = join(sourceDir, MIRROR_MANIFEST);
  const expectedMd5 = checksum?.startsWith("md5:") ? checksum.slice("md5:".length) : undefined;

  let downloaded = false;
  if (!await fileExists(zipPath) || (expectedMd5 && await md5File(zipPath) !== expectedMd5)) {
    log.info(`  downloading ${fileName} (${size.toLocaleString()} bytes)`);
    await downloadFile(downloadUrl, zipPath, isDraft ? token : undefined);
    downloaded = true;
  }

  const actualMd5 = await md5File(zipPath);
  if (expectedMd5 && actualMd5 !== expectedMd5) {
    throw new Error(`Zenodo checksum mismatch for ${fileName}: expected ${expectedMd5}, got ${actualMd5}`);
  }

  if (await fileExists(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    if (manifest.recordId === recordId && manifest.fileName === fileName && manifest.checksum === actualMd5 && manifest.size === size) {
      log.ok(`${fileName} already mirrored and verified`);
      log.ok(`source mirror: ${sourceDir}`);
      return {
        recordId,
        sourceDir,
        zipPath,
        checksum: expectedMd5 ?? actualMd5,
        size,
      };
    }
  }

  await rm(sourceDir, { recursive: true, force: true });
  await ensureDir(sourceDir);
  await extractZip(zipPath, sourceDir);
  await writeFile(
    manifestPath,
    `${JSON.stringify({ recordId, fileName, checksum: actualMd5, size, mirroredAt: new Date().toISOString() }, null, 2)}\n`,
    "utf-8",
  );

  log.ok(`${downloaded ? "downloaded and extracted" : "verified and extracted"} ${fileName}`);
  log.ok(`source mirror: ${sourceDir}`);

  return {
    recordId,
    sourceDir,
    zipPath,
    checksum: expectedMd5 ?? actualMd5,
    size,
  };
}
