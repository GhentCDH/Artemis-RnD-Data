import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { generateId } from "@allmaps/id";

type V2Collection = {
  "@type"?: string;
  "@context"?: string;
  "@id"?: string;
  label?: string;
  manifests?: Array<{ "@id": string; label?: string }>;
};

type V2Manifest = {
  "@id"?: string;
  "@type"?: string;
  label?: string;
  sequences?: Array<{
    canvases?: Array<{
      "@id"?: string;
      label?: string;
    }>;
  }>;
};

type IndexEntry = {
  label: string;
  sourceManifestUrl: string;

  // Our build outputs (paths are relative to build/)
  compiledManifestPath: string; // next stage
  mirroredAllmapsAnnotationPath: string;

  canvasCount: number;

  // Allmaps (manifest-based)
  manifestAllmapsId: string;
  manifestAllmapsUrl: string;
  manifestAllmapsStatus: number;

  canvasIds: string[];
};

function parseLines(txt: string): string[] {
  return txt
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return await res.json();
}

/**
 * Cache any URL -> JSON file on disk
 * - Keeps reruns fast
 * - Avoids hammering endpoints
 */
async function cachedJson(url: string, cacheDir: string): Promise<any> {
  await mkdir(cacheDir, { recursive: true });
  const key = sha1(url);
  const path = `${cacheDir}/${key}.json`;

  if (await exists(path)) {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  }

  const json = await fetchJson(url);
  await writeFile(path, JSON.stringify(json, null, 2), "utf-8");
  return json;
}

function listManifestRefs(collection: V2Collection): Array<{ url: string; label: string }> {
  const manifests = collection.manifests ?? [];
  return manifests
    .map((m) => ({ url: (m["@id"] ?? "").toString(), label: (m.label ?? "").toString() }))
    .filter((m) => m.url.length > 0);
}

function extractCanvasIds(man: V2Manifest): string[] {
  const canvases = man.sequences?.[0]?.canvases ?? [];
  return canvases
    .map((c) => (c["@id"] ?? "").toString())
    .filter((id) => id.length > 0);
}

async function getStatus(url: string): Promise<number> {
  const res = await fetch(url, { method: "GET", redirect: "follow" });
  return res.status;
}

async function writeMirroredAllmapsManifestAnnotation(
  manifestAllmapsId: string,
  allmapsUrl: string
): Promise<{ status: number; outPath: string }> {
  // Mirror to build/ so GitHub Pages can serve it
  const outDir = "build/allmaps/manifests";
  await mkdir(outDir, { recursive: true });

  const outPath = `${outDir}/${manifestAllmapsId}.json`;

  // If already mirrored, don’t refetch (fast reruns)
  if (await exists(outPath)) {
    return { status: 200, outPath };
  }

  const res = await fetch(allmapsUrl, { redirect: "follow" });
  const status = res.status;

  if (status !== 200) {
    // Don’t create junk files for 404 etc.
    return { status, outPath };
  }

  const json = await res.json();
  await writeFile(outPath, JSON.stringify(json, null, 2), "utf-8");
  return { status, outPath };
}

async function main() {
  await mkdir("cache/collections", { recursive: true });
  await mkdir("cache/manifests", { recursive: true });
  await mkdir("build", { recursive: true });

  const sourcesTxt = await readFile("data/sources/collections.txt", "utf-8");
  const collectionUrls = parseLines(sourcesTxt);

  if (collectionUrls.length < 1) {
    throw new Error("No collection URLs found in data/sources/collections.txt");
  }
  if (collectionUrls.length > 1) {
    console.warn(`Multiple collections listed (${collectionUrls.length}). This pipeline currently expects 1; using the first.`);
  }

  const collectionUrl = collectionUrls[0];

  console.log(`[1/5] Fetch collection: ${collectionUrl}`);
  const col = (await cachedJson(collectionUrl, "cache/collections")) as V2Collection;

  const manifestRefs = listManifestRefs(col);
  console.log(`[2/5] Manifests in collection: ${manifestRefs.length}`);

  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
  const slice =
    typeof limit === "number" && Number.isFinite(limit) ? manifestRefs.slice(0, limit) : manifestRefs;

  console.log(`[3/5] Processing manifests: ${slice.length}${limit ? ` (LIMIT=${limit})` : ""}`);

  const index: IndexEntry[] = [];
  let georefManifests = 0;
  let mirroredOk = 0;

  for (let i = 0; i < slice.length; i++) {
    const { url, label } = slice[i];
    console.log(`  - [${i + 1}/${slice.length}] ${label || "(no label)"} :: ${url}`);

    const man = (await cachedJson(url, "cache/manifests")) as V2Manifest;
    const canvasIds = extractCanvasIds(man);

    // Allmaps: manifest-based lookup (generateId is async)
    const manifestAllmapsId = await generateId(url);
    const manifestAllmapsUrl = `https://annotations.allmaps.org/manifests/${manifestAllmapsId}`;

    if (i === 0) console.log(`    allmaps url: ${manifestAllmapsUrl}`);

    // Probe status (cheap)
    const manifestAllmapsStatus = await getStatus(manifestAllmapsUrl);
    if (manifestAllmapsStatus === 200) georefManifests++;

    // Mirror (only if 200)
    let mirroredAllmapsAnnotationPath = "";
    if (manifestAllmapsStatus === 200) {
      const mirror = await writeMirroredAllmapsManifestAnnotation(manifestAllmapsId, manifestAllmapsUrl);
      if (mirror.status === 200) mirroredOk++;
      mirroredAllmapsAnnotationPath = mirror.outPath.replace(/^build\//, "");
    }

    const slug = sha1(url).slice(0, 16);
    const compiledManifestPath = `manifests/${slug}.json`; // next stage

    index.push({
      label: (man.label ?? label ?? "").toString(),
      sourceManifestUrl: url,

      compiledManifestPath,
      mirroredAllmapsAnnotationPath,

      canvasCount: canvasIds.length,

      manifestAllmapsId,
      manifestAllmapsUrl,
      manifestAllmapsStatus,

      canvasIds
    });
  }

  console.log(`[4/5] Writing build/index.json`);
  const out = {
    collectionUrl,
    generatedAt: new Date().toISOString(),
    totalManifests: index.length,
    georefManifests,
    mirroredOk,
    index
  };

  await writeFile("build/index.json", JSON.stringify(out, null, 2), "utf-8");

  console.log(`[5/5] Done. manifests=${index.length}, georefManifests=${georefManifests}, mirroredOk=${mirroredOk}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
