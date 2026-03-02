import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { generateId } from "@allmaps/id";

type V2Collection = {
  "@context"?: string;
  "@id"?: string;
  "@type"?: string;
  label?: string;
  description?: any;
  manifests?: Array<{ "@id": string; "@type"?: string; label?: string }>;
};

type V2Manifest = Record<string, any>;

type IndexEntry = {
  label: string;
  sourceManifestUrl: string;

  compiledManifestPath: string; // build/manifests/<slug>.json (relative to build/)
  mirroredAllmapsAnnotationPath: string; // build/allmaps/manifests/<id>.json (relative to build/)

  canvasCount: number;

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

function extractCanvasIdsFromV2Manifest(man: V2Manifest): string[] {
  const canvases = man?.sequences?.[0]?.canvases ?? [];
  return (Array.isArray(canvases) ? canvases : [])
    .map((c: any) => (c?.["@id"] ?? "").toString())
    .filter((id: string) => id.length > 0);
}

async function getStatus(url: string): Promise<number> {
  const res = await fetch(url, { method: "GET", redirect: "follow" });
  return res.status;
}

async function mirrorAllmapsManifestAnnotation(
  manifestAllmapsId: string,
  allmapsUrl: string
): Promise<{ status: number; relPath: string }> {
  const outDir = "build/allmaps/manifests";
  await mkdir(outDir, { recursive: true });

  const outAbs = `${outDir}/${manifestAllmapsId}.json`;
  const outRel = outAbs.replace(/^build\//, "");

  if (await exists(outAbs)) {
    return { status: 200, relPath: outRel };
  }

  const res = await fetch(allmapsUrl, { redirect: "follow" });
  const status = res.status;
  if (status !== 200) return { status, relPath: "" };

  const json = await res.json();
  await writeFile(outAbs, JSON.stringify(json, null, 2), "utf-8");
  return { status: 200, relPath: outRel };
}

/**
 * Patch a v2 manifest by attaching a canvas-level AnnotationList reference via otherContent.
 * We point to our mirrored Allmaps annotation JSON hosted under build/.
 */
function compileV2ManifestAttachOtherContent(
  source: V2Manifest,
  mirroredAnnotationRelPath: string,
  buildBaseUrl: string | null
): V2Manifest {
  const out: V2Manifest = JSON.parse(JSON.stringify(source));

  const canvases = out?.sequences?.[0]?.canvases;
  if (!Array.isArray(canvases)) return out;

  // If we have a base URL (GitHub Pages), we can embed full URLs in manifests.
  // Otherwise we store relative paths; your viewer can resolve them.
  const annotationId = buildBaseUrl
    ? `${buildBaseUrl.replace(/\/+$/, "")}/${mirroredAnnotationRelPath}`
    : mirroredAnnotationRelPath;

  for (const canvas of canvases) {
    if (!canvas || typeof canvas !== "object") continue;

    const entry = {
      "@id": annotationId,
      "@type": "sc:AnnotationList",
      "label": "Georeferencing (Allmaps, mirrored by Artemis)"
    };

    // Merge: keep any existing otherContent, append ours if not already present
    const oc = canvas.otherContent;
    if (Array.isArray(oc)) {
      const already = oc.some((x: any) => x?.["@id"] === entry["@id"]);
      if (!already) oc.push(entry);
      canvas.otherContent = oc;
    } else if (oc) {
      // If it's a single object, normalize to array
      const arr = [oc];
      const already = arr.some((x: any) => x?.["@id"] === entry["@id"]);
      if (!already) arr.push(entry);
      canvas.otherContent = arr;
    } else {
      canvas.otherContent = [entry];
    }
  }

  // Add provenance metadata (minimal, non-destructive)
  out.metadata = Array.isArray(out.metadata) ? out.metadata : [];
  out.metadata.push(
    { label: "Artemis pipeline", value: "Compiled manifest with mirrored Allmaps georeferencing" }
  );

  return out;
}

async function main() {
  await mkdir("cache/collections", { recursive: true });
  await mkdir("cache/manifests", { recursive: true });
  await mkdir("build", { recursive: true });
  await mkdir("build/manifests", { recursive: true });

  const sourcesTxt = await readFile("data/sources/collections.txt", "utf-8");
  const collectionUrls = parseLines(sourcesTxt);
  if (collectionUrls.length < 1) throw new Error("No collection URLs found in data/sources/collections.txt");

  const collectionUrl = collectionUrls[0];

  // Optional: set BUILD_BASE_URL to your GH Pages root later
  // e.g. https://ghentcdh.github.io/Artemis-RnD-Data
  const buildBaseUrl = process.env.BUILD_BASE_URL ?? null;

  console.log(`[1/6] Fetch collection: ${collectionUrl}`);
  const col = (await cachedJson(collectionUrl, "cache/collections")) as V2Collection;

  const manifestRefs = listManifestRefs(col);
  console.log(`[2/6] Manifests in collection: ${manifestRefs.length}`);

  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
  const slice =
    typeof limit === "number" && Number.isFinite(limit) ? manifestRefs.slice(0, limit) : manifestRefs;

  console.log(`[3/6] Processing manifests: ${slice.length}${limit ? ` (LIMIT=${limit})` : ""}`);

  const index: IndexEntry[] = [];
  let georefManifests = 0;
  let mirroredOk = 0;
  let compiledOk = 0;

  for (let i = 0; i < slice.length; i++) {
    const { url, label } = slice[i];
    console.log(`  - [${i + 1}/${slice.length}] ${label || "(no label)"} :: ${url}`);

    const man = (await cachedJson(url, "cache/manifests")) as V2Manifest;
    const canvasIds = extractCanvasIdsFromV2Manifest(man);

    const manifestAllmapsId = await generateId(url);
    const manifestAllmapsUrl = `https://annotations.allmaps.org/manifests/${manifestAllmapsId}`;
    if (i === 0) console.log(`    allmaps url: ${manifestAllmapsUrl}`);

    const manifestAllmapsStatus = await getStatus(manifestAllmapsUrl);
    if (manifestAllmapsStatus === 200) georefManifests++;

    let mirroredRel = "";
    if (manifestAllmapsStatus === 200) {
      const mirror = await mirrorAllmapsManifestAnnotation(manifestAllmapsId, manifestAllmapsUrl);
      if (mirror.status === 200 && mirror.relPath) {
        mirroredOk++;
        mirroredRel = mirror.relPath;
      }
    }

    const slug = sha1(url).slice(0, 16);
    const compiledManifestRel = `manifests/${slug}.json`;
    const compiledManifestAbs = `build/${compiledManifestRel}`;

    if (mirroredRel) {
      const compiled = compileV2ManifestAttachOtherContent(man, mirroredRel, buildBaseUrl);
      await writeFile(compiledManifestAbs, JSON.stringify(compiled, null, 2), "utf-8");
      compiledOk++;
    } else {
      // Still write the manifest untouched so the collection stays complete
      await writeFile(compiledManifestAbs, JSON.stringify(man, null, 2), "utf-8");
    }

    index.push({
      label: (man.label ?? label ?? "").toString(),
      sourceManifestUrl: url,

      compiledManifestPath: compiledManifestRel,
      mirroredAllmapsAnnotationPath: mirroredRel,

      canvasCount: canvasIds.length,

      manifestAllmapsId,
      manifestAllmapsUrl,
      manifestAllmapsStatus,

      canvasIds
    });
  }

  console.log(`[4/6] Writing build/index.json`);
  const indexOut = {
    collectionUrl,
    generatedAt: new Date().toISOString(),
    totalManifests: index.length,
    georefManifests,
    mirroredOk,
    compiledOk,
    index
  };
  await writeFile("build/index.json", JSON.stringify(indexOut, null, 2), "utf-8");

  console.log(`[5/6] Writing build/collection.json`);
  // Build a published v2 collection that points to our compiled manifests
  const buildCollectionId = buildBaseUrl
    ? `${buildBaseUrl.replace(/\/+$/, "")}/collection.json`
    : "collection.json";

  const buildCollection: V2Collection = {
    "@context": "http://iiif.io/api/presentation/2/context.json",
    "@id": buildCollectionId,
    "@type": "sc:Collection",
    label: (col.label ?? "Artemis compiled collection").toString(),
    manifests: index.map((e) => {
      const mid = buildBaseUrl
        ? `${buildBaseUrl.replace(/\/+$/, "")}/${e.compiledManifestPath}`
        : e.compiledManifestPath;

      return {
        "@id": mid,
        "@type": "sc:Manifest",
        label: e.label
      };
    })
  };

  await writeFile("build/collection.json", JSON.stringify(buildCollection, null, 2), "utf-8");

  console.log(`[6/6] Done. manifests=${index.length}, georefManifests=${georefManifests}, mirroredOk=${mirroredOk}, compiledOk=${compiledOk}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
