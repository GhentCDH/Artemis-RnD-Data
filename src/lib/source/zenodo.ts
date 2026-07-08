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
  isDraft: boolean;
};

export type ZenodoSourceOptions = {
  /** Required if the record turns out to be an unpublished draft - viewing a draft requires ownership auth. */
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

/**
 * Auto-detects whether a record id refers to a published record or an
 * unpublished draft: Zenodo's public record API 404s for anything not
 * published, so a 404 there is treated as "try the authenticated draft API
 * next" rather than "record doesn't exist". Requires a token only in the
 * draft case, since checking the public API needs none.
 */
export async function detectZenodoDraftStatus(recordId: string, token?: string): Promise<boolean> {
  const publicUrl = zenodoRecordApiUrl(recordId);
  const publicRes = await fetch(publicUrl, { headers: { Accept: "application/json" } });
  if (publicRes.ok) return false;
  if (publicRes.status !== 404) {
    throw new Error(`Zenodo API request failed (${publicRes.status} ${publicRes.statusText}): ${publicUrl}`);
  }

  if (!token) {
    throw new Error(`Zenodo record ${recordId} was not found as a published record; ZENODO_TOKEN is required to check whether it's an unpublished draft`);
  }
  const draftUrl = `${publicUrl}/draft`;
  const draftRes = await fetch(draftUrl, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
  if (draftRes.ok) return true;
  throw new Error(`Zenodo record ${recordId} is neither a published record nor an accessible draft (draft check: ${draftRes.status} ${draftRes.statusText})`);
}

/** List the files in an unpublished draft, given the draft's own record id. */
export async function listDraftFiles(draftId: string, token: string): Promise<ZenodoDraftFileEntry[]> {
  const listing = await fetchJson<ZenodoDraftFiles>(`https://zenodo.org/api/records/${draftId}/draft/files`, token);
  return listing.entries ?? [];
}

/**
 * Filename → public download URL for every file in a *published* Zenodo
 * record (not just Source.zip). Used to resolve sublayer `download:` filenames
 * to real links; drafts have no public download URL, so callers should skip
 * this for draft builds rather than call it.
 */
export async function fetchRecordFileIndex(recordId: string): Promise<Map<string, string>> {
  const record = await fetchJson<ZenodoRecord>(zenodoRecordApiUrl(recordId));
  const index = new Map<string, string>();
  for (const file of record.files ?? []) {
    if (file.links?.self) index.set(file.key, file.links.self);
  }
  return index;
}

function zenodoDraftFileContentUrl(draftId: string, fileName: string): string {
  return `https://zenodo.org/api/records/${draftId}/draft/files/${encodeURIComponent(fileName)}/content`;
}

/**
 * Whichever OS/tool made the zip (macOS Finder's "Compress" adds a
 * `__MACOSX/` sidecar tree of AppleDouble `._*` resource-fork files; Windows
 * Explorer can leave `Thumbs.db`/`desktop.ini`; either OS may carry a stray
 * `.DS_Store`), this is pure filesystem-metadata junk, never real content.
 * Must be excluded before wrapping-dir detection below, or a junk entry with
 * a different top-level folder (e.g. `__MACOSX/`) looks like a second,
 * inconsistent top-level entry and defeats that detection entirely.
 */
const JUNK_BASENAMES = new Set(["thumbs.db", "desktop.ini", "ehthumbs.db", ".ds_store"]);

function isJunkEntry(name: string): boolean {
  const clean = name.replace(/^\/+/, "");
  const segments = clean.split("/");
  if (segments[0] === "__MACOSX") return true;
  const basename = segments[segments.length - 1];
  return basename.startsWith("._") || JUNK_BASENAMES.has(basename.toLowerCase());
}

/**
 * If every entry shares the same single first path segment (e.g. the zip was
 * made from the parent of `Source/` instead of its contents), that segment is
 * just wrapping - not part of the real layout - so callers should strip it.
 */
function commonWrappingDir(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  let wrapping: string | undefined;
  for (const name of names) {
    const clean = name.replace(/^\/+/, "");
    const slash = clean.indexOf("/");
    if (slash === -1) return undefined; // a bare top-level file rules out a wrapping dir
    const first = clean.slice(0, slash);
    if (wrapping === undefined) wrapping = first;
    else if (wrapping !== first) return undefined;
  }
  return wrapping;
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
  const files = unzipSync(new Uint8Array(await readFile(zipPath)));
  const realNames = Object.keys(files).filter((name) => !isJunkEntry(name));
  const wrapping = commonWrappingDir(realNames);
  if (wrapping) log.warn(`Source.zip wraps everything in a top-level '${wrapping}/' folder; stripping it during extraction`);

  const normalizedDestination = normalize(destination);
  for (const name of realNames) {
    if (name.endsWith("/")) continue;
    const content = files[name];
    const relativeName = wrapping ? name.slice(wrapping.length + 1) : name;
    if (!relativeName) continue;
    const outputPath = normalize(join(destination, relativeName));
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
  const { token } = options;
  const isDraft = await detectZenodoDraftStatus(recordId, token);
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
        isDraft,
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
    isDraft,
  };
}
