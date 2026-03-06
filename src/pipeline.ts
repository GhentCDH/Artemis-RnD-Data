import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
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

type SourceGroup = {
  sourceCollectionUrl: string;
  sourceCollectionLabel: string;
  refs: Array<{ url: string; label: string }>;
};

type IndexEntry = {
  label: string;
  sourceManifestUrl: string;
  sourceCollectionUrl: string;

  compiledManifestPath: string; // build/manifests/<slug>.json (relative to build/)
  mirroredAllmapsAnnotationPath: string; // build/allmaps/manifests/<id>.json (relative to build/)

  canvasCount: number;

  manifestAllmapsId: string;
  manifestAllmapsUrl: string;
  manifestAllmapsStatus: number;
  canvasAllmapsHits: Array<{
    canvasId: string;
    canvasAllmapsId: string;
    canvasAllmapsUrl: string;
    canvasAllmapsStatus: number;
    mirroredAllmapsAnnotationPath: string;
  }>;
  georefDetectedBy: "none" | "manifest" | "canvas";
  isVerzamelblad: boolean;
  annotSource: "single" | "multi" | "none";

  canvasIds: string[];
};

// Manifests with self-intersecting resource masks — excluded from build.
// These cause CDT triangulation failures in Allmaps (Edge intersects already constrained edge).
const PROBLEMATIC_MANIFEST_IDS = new Set([
  "04930d7222f43159", // ANTWERPEN - Verzamelplan
  "787106327b287f41", // ANTWERPEN - Sectie B
  "949c44555577f899", // ANTWERPEN - Sectie C
  "e621fad69cecfcb5", // Kalken - Sectie B
]);

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

async function mirrorAllmapsAnnotation(
  endpoint: "manifests" | "canvases",
  allmapsId: string,
  allmapsUrl: string
): Promise<{ status: number; relPath: string }> {
  const outDir = `build/allmaps/${endpoint}`;
  await mkdir(outDir, { recursive: true });

  const outAbs = `${outDir}/${allmapsId}.json`;
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
  mirroredManifestAnnotationRelPath: string,
  mirroredCanvasAnnotationRelPaths: Record<string, string>,
  buildBaseUrl: string | null
): V2Manifest {
  const out: V2Manifest = JSON.parse(JSON.stringify(source));

  const canvases = out?.sequences?.[0]?.canvases;
  if (!Array.isArray(canvases)) return out;

  const absOrRel = (path: string): string =>
    buildBaseUrl ? `${buildBaseUrl.replace(/\/+$/, "")}/${path}` : path;

  for (const canvas of canvases) {
    if (!canvas || typeof canvas !== "object") continue;
    const canvasId = (canvas["@id"] ?? "").toString();
    const relPath = mirroredCanvasAnnotationRelPaths[canvasId] || mirroredManifestAnnotationRelPath;
    if (!relPath) continue;
    const annotationId = absOrRel(relPath);

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
    {
      label: "Artemis pipeline",
      value: "Compiled manifest with mirrored Allmaps georeferencing (manifest- and canvas-level)"
    }
  );

  return out;
}

function hasVerzamelbladIdentifier(man: V2Manifest, url: string, label: string): boolean {
  const blob = [
    url,
    label,
    (man?.["@id"] ?? "").toString(),
    (man?.label ?? "").toString(),
    JSON.stringify(man?.identifier ?? ""),
    JSON.stringify(man?.metadata ?? "")
  ].join(" ");
  return /\bverzamel(?:blad|plan(?:nen)?)\b/i.test(blob);
}

function normalizeSourceCollectionLabel(label: string): string {
  return label.replace(/^\s*artemis\s*[-–—:]\s*/i, "").trim();
}

async function resolveSourceGroup(collectionUrl: string): Promise<SourceGroup> {
  const json = (await cachedJson(collectionUrl, "cache/collections")) as V2Collection;
  const label = normalizeSourceCollectionLabel((json.label ?? "").toString());
  let refs = listManifestRefs(json);
  // If the URL has no manifests array, treat it as a direct manifest
  if (refs.length === 0) {
    refs = [{ url: collectionUrl, label }];
  }
  // Deduplicate within this source
  const seen = new Set<string>();
  refs = refs.filter(({ url }) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  return { sourceCollectionUrl: collectionUrl, sourceCollectionLabel: label, refs };
}

async function processManifestRef(
  { url, label }: { url: string; label: string },
  sourceCollectionUrl: string,
  buildBaseUrl: string | null,
  i: number,
  total: number
): Promise<{ entry: IndexEntry; georef: boolean; mirrored: boolean; compiled: boolean }> {
  console.log(`  - [${i + 1}/${total}] ${label || "(no label)"} :: ${url}`);

  const man = (await cachedJson(url, "cache/manifests")) as V2Manifest;
  const canvasIds = extractCanvasIdsFromV2Manifest(man);
  const isVerzamelblad = hasVerzamelbladIdentifier(man, url, label);

  const manifestAllmapsId = await generateId(url);
  const manifestAllmapsUrl = `https://annotations.allmaps.org/manifests/${manifestAllmapsId}`;
  const manifestAllmapsStatus = await getStatus(manifestAllmapsUrl);
  const manifestGeoreferenced = manifestAllmapsStatus === 200;

  let mirroredManifestRel = "";
  if (manifestGeoreferenced) {
    const mirror = await mirrorAllmapsAnnotation("manifests", manifestAllmapsId, manifestAllmapsUrl);
    if (mirror.status === 200 && mirror.relPath) mirroredManifestRel = mirror.relPath;
  }

  const canvasAllmapsHits: IndexEntry["canvasAllmapsHits"] = [];
  const mirroredCanvasRelByCanvasId: Record<string, string> = {};
  for (const canvasId of canvasIds) {
    const canvasAllmapsId = await generateId(canvasId);
    const canvasAllmapsUrl = `https://annotations.allmaps.org/canvases/${canvasAllmapsId}`;
    const canvasAllmapsStatus = await getStatus(canvasAllmapsUrl);
    let mirroredAllmapsAnnotationPath = "";
    if (canvasAllmapsStatus === 200) {
      const mirror = await mirrorAllmapsAnnotation("canvases", canvasAllmapsId, canvasAllmapsUrl);
      if (mirror.status === 200 && mirror.relPath) {
        mirroredAllmapsAnnotationPath = mirror.relPath;
        mirroredCanvasRelByCanvasId[canvasId] = mirror.relPath;
      }
    }
    canvasAllmapsHits.push({
      canvasId,
      canvasAllmapsId,
      canvasAllmapsUrl,
      canvasAllmapsStatus,
      mirroredAllmapsAnnotationPath
    });
  }
  const hasCanvasGeoref = canvasAllmapsHits.some((x) => x.canvasAllmapsStatus === 200);
  const georefDetectedBy: IndexEntry["georefDetectedBy"] = hasCanvasGeoref
    ? "canvas"
    : manifestGeoreferenced
      ? "manifest"
      : "none";
  const georefDetected = georefDetectedBy !== "none";

  const slug = sha1(url).slice(0, 16);
  const compiledManifestRel = `manifests/${slug}.json`;
  const compiledManifestAbs = `build/${compiledManifestRel}`;

  let didCompile = false;
  if (mirroredManifestRel || hasCanvasGeoref) {
    const compiled = compileV2ManifestAttachOtherContent(
      man,
      mirroredManifestRel,
      mirroredCanvasRelByCanvasId,
      buildBaseUrl
    );
    await writeFile(compiledManifestAbs, JSON.stringify(compiled, null, 2), "utf-8");
    didCompile = true;
  } else {
    // Still write the manifest untouched so the collection stays complete
    await writeFile(compiledManifestAbs, JSON.stringify(man, null, 2), "utf-8");
  }

  return {
    entry: {
      label: (man.label ?? label ?? "").toString(),
      sourceManifestUrl: url,
      sourceCollectionUrl,
      compiledManifestPath: compiledManifestRel,
      mirroredAllmapsAnnotationPath: mirroredManifestRel,
      canvasCount: canvasIds.length,
      manifestAllmapsId,
      manifestAllmapsUrl,
      manifestAllmapsStatus,
      canvasAllmapsHits,
      georefDetectedBy,
      isVerzamelblad,
      annotSource: georefDetectedBy === "none" ? "none" : canvasIds.length === 1 ? "single" : "multi",
      canvasIds
    },
    georef: georefDetected,
    mirrored: mirroredManifestRel.length > 0 || hasCanvasGeoref,
    compiled: didCompile
  };
}

async function main() {
  await mkdir("cache/collections", { recursive: true });
  await mkdir("cache/manifests", { recursive: true });

  // Clean build output dirs so stale files from previous runs don't linger.
  // Cache is intentionally preserved.
  console.log("[0/5] Cleaning build output directories...");
  for (const dir of ["build/manifests", "build/collections", "build/allmaps"]) {
    await rm(dir, { recursive: true, force: true });
  }
  await mkdir("build", { recursive: true });
  await mkdir("build/manifests", { recursive: true });
  await mkdir("build/collections", { recursive: true });

  const sourcesTxt = await readFile("data/sources/collections.txt", "utf-8");
  const collectionUrls = parseLines(sourcesTxt);
  if (collectionUrls.length < 1) throw new Error("No collection URLs found in data/sources/collections.txt");

  // Optional: set BUILD_BASE_URL to your GH Pages root later
  // e.g. https://ghentcdh.github.io/Artemis-RnD-Data
  const buildBaseUrl = process.env.BUILD_BASE_URL ?? null;
  const base = (path: string) =>
    buildBaseUrl ? `${buildBaseUrl.replace(/\/+$/, "")}/${path}` : path;

  console.log(`[1/5] Resolving manifests from ${collectionUrls.length} source(s)...`);
  const sourceGroups: SourceGroup[] = [];
  for (const collectionUrl of collectionUrls) {
    console.log(`  - ${collectionUrl}`);
    const group = await resolveSourceGroup(collectionUrl);
    console.log(`    label: "${group.sourceCollectionLabel}" -> ${group.refs.length} manifest(s)`);
    sourceGroups.push(group);
  }

  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;
  const totalRefs = sourceGroups.reduce((n, g) => n + g.refs.length, 0);
  console.log(`[2/5] Total manifests: ${totalRefs}${limit ? ` (LIMIT=${limit} applied per source)` : ""}`);

  console.log(`[3/5] Processing manifests per source...`);
  const index: IndexEntry[] = [];
  const problematicManifests: Array<{
    manifestAllmapsId: string;
    label: string;
    sourceManifestUrl: string;
    reason: string;
  }> = [];
  let georefManifests = 0;
  let mirroredOk = 0;
  let compiledOk = 0;

  for (const group of sourceGroups) {
    console.log(`  Source: ${group.sourceCollectionUrl}`);
    const slice = typeof limit === "number" && Number.isFinite(limit)
      ? group.refs.slice(0, limit)
      : group.refs;

    for (let i = 0; i < slice.length; i++) {
      const ref = slice[i];
      const checkId = await generateId(ref.url);
      if (PROBLEMATIC_MANIFEST_IDS.has(checkId)) {
        console.warn(`[SKIP] Problematic manifest excluded: ${ref.url} (${checkId})`);
        problematicManifests.push({
          manifestAllmapsId: checkId,
          label: ref.label,
          sourceManifestUrl: ref.url,
          reason: "self-intersecting resource mask"
        });
        continue;
      }

      const result = await processManifestRef(
        ref,
        group.sourceCollectionUrl,
        buildBaseUrl,
        i,
        slice.length
      );
      index.push(result.entry);
      if (result.georef) georefManifests++;
      if (result.mirrored) mirroredOk++;
      if (result.compiled) compiledOk++;
    }
  }

  console.log(`[4/5] Writing per-source compiled collections and build/index.json`);

  // Group index entries back by source for per-layer output
  const layerMeta: Array<{
    sourceCollectionUrl: string;
    sourceCollectionLabel: string;
    compiledCollectionPath: string;
    manifestCount: number;
    georefCount: number;
    singleCanvasGeorefCount: number;
    multiCanvasGeorefCount: number;
  }> = [];
  const renderLayerMeta: Array<{
    sourceCollectionUrl: string;
    sourceCollectionLabel: string;
    renderLayerKey: "default" | "verzamelblad" | "single-canvas" | "multi-canvas";
    parentRenderLayerKey?: "default";
    compiledCollectionPath: string;
    manifestCount: number;
    georefCount: number;
    singleCanvasGeorefCount: number;
    multiCanvasGeorefCount: number;
    hidden: boolean;
  }> = [];

  for (const group of sourceGroups) {
    const entries = index.filter((e) => e.sourceCollectionUrl === group.sourceCollectionUrl);
    const colSlug = sha1(group.sourceCollectionUrl).slice(0, 16);
    const colRelPath = `collections/${colSlug}.json`;
    const colAbsPath = `build/${colRelPath}`;

    const colId = base(colRelPath);
    const col: V2Collection = {
      "@context": "http://iiif.io/api/presentation/2/context.json",
      "@id": colId,
      "@type": "sc:Collection",
      label: group.sourceCollectionLabel || group.sourceCollectionUrl,
      manifests: entries.map((e) => ({
        "@id": base(e.compiledManifestPath),
        "@type": "sc:Manifest",
        label: e.label
      }))
    };
    await writeFile(colAbsPath, JSON.stringify(col, null, 2), "utf-8");

    layerMeta.push({
      sourceCollectionUrl: group.sourceCollectionUrl,
      sourceCollectionLabel: group.sourceCollectionLabel,
      compiledCollectionPath: colRelPath,
      manifestCount: entries.length,
      georefCount: entries.filter((e) => e.georefDetectedBy !== "none").length,
      singleCanvasGeorefCount: entries.filter((e) => e.annotSource === "single").length,
      multiCanvasGeorefCount: entries.filter((e) => e.annotSource === "multi").length
    });

    const entriesByRenderLayer: Record<"default" | "verzamelblad", IndexEntry[]> = {
      default: entries.filter((e) => !e.isVerzamelblad),
      verzamelblad: entries.filter((e) => e.isVerzamelblad)
    };

    for (const renderLayerKey of ["default", "verzamelblad"] as const) {
      const renderEntries = entriesByRenderLayer[renderLayerKey];
      if (renderEntries.length < 1) continue;
      const renderLayerSlug = sha1(`${group.sourceCollectionUrl}::${renderLayerKey}`).slice(0, 16);
      const renderLayerRelPath = `collections/${renderLayerSlug}.json`;
      const renderLayerAbsPath = `build/${renderLayerRelPath}`;
      const renderLayerLabel = renderLayerKey === "verzamelblad"
        ? `${group.sourceCollectionLabel || group.sourceCollectionUrl} - Verzamelblad`
        : group.sourceCollectionLabel || group.sourceCollectionUrl;
      const renderLayerColId = base(renderLayerRelPath);
      const renderLayerCol: V2Collection = {
        "@context": "http://iiif.io/api/presentation/2/context.json",
        "@id": renderLayerColId,
        "@type": "sc:Collection",
        label: renderLayerLabel,
        manifests: renderEntries.map((e) => ({
          "@id": base(e.compiledManifestPath),
          "@type": "sc:Manifest",
          label: e.label
        }))
      };
      await writeFile(renderLayerAbsPath, JSON.stringify(renderLayerCol, null, 2), "utf-8");
      renderLayerMeta.push({
        sourceCollectionUrl: group.sourceCollectionUrl,
        sourceCollectionLabel: group.sourceCollectionLabel,
        renderLayerKey,
        compiledCollectionPath: renderLayerRelPath,
        manifestCount: renderEntries.length,
        georefCount: renderEntries.filter((e) => e.georefDetectedBy !== "none").length,
        singleCanvasGeorefCount: renderEntries.filter((e) => e.annotSource === "single").length,
        multiCanvasGeorefCount: renderEntries.filter((e) => e.annotSource === "multi").length,
        hidden: false
      });
    }

    // Debug sub-layers: split the default layer by canvas count so the viewer can
    // load single-canvas and multi-canvas annotations independently to isolate rendering bugs.
    const defaultEntries = entriesByRenderLayer["default"];
    const defaultLabel = group.sourceCollectionLabel || group.sourceCollectionUrl;
    for (const canvasKey of ["single-canvas", "multi-canvas"] as const) {
      const annotSource = canvasKey === "single-canvas" ? "single" : "multi";
      const subEntries = defaultEntries.filter((e) => e.annotSource === annotSource);
      if (subEntries.length < 1) continue;
      const subSlug = sha1(`${group.sourceCollectionUrl}::default::${canvasKey}`).slice(0, 16);
      const subRelPath = `collections/${subSlug}.json`;
      const subAbsPath = `build/${subRelPath}`;
      const subCol: V2Collection = {
        "@context": "http://iiif.io/api/presentation/2/context.json",
        "@id": base(subRelPath),
        "@type": "sc:Collection",
        label: `${defaultLabel} (${canvasKey})`,
        manifests: subEntries.map((e) => ({
          "@id": base(e.compiledManifestPath),
          "@type": "sc:Manifest",
          label: e.label
        }))
      };
      await writeFile(subAbsPath, JSON.stringify(subCol, null, 2), "utf-8");
      renderLayerMeta.push({
        sourceCollectionUrl: group.sourceCollectionUrl,
        sourceCollectionLabel: group.sourceCollectionLabel,
        renderLayerKey: canvasKey,
        parentRenderLayerKey: "default",
        compiledCollectionPath: subRelPath,
        manifestCount: subEntries.length,
        georefCount: subEntries.length,
        singleCanvasGeorefCount: canvasKey === "single-canvas" ? subEntries.length : 0,
        multiCanvasGeorefCount: canvasKey === "multi-canvas" ? subEntries.length : 0,
        hidden: true
      });
    }
  }

  // index.json: layer list + full per-manifest detail (grouped)
  const indexOut = {
    generatedAt: new Date().toISOString(),
    totalManifests: index.length,
    georefManifests,
    mirroredOk,
    compiledOk,
    layers: layerMeta,
    renderLayers: renderLayerMeta,
    problematicManifests,
    index
  };
  await writeFile("build/index.json", JSON.stringify(indexOut, null, 2), "utf-8");

  const problematicLog = problematicManifests.map((m) =>
    `[SKIP] ${m.manifestAllmapsId}  ${m.label}\n       ${m.sourceManifestUrl}\n       reason: ${m.reason}`
  ).join("\n");
  await writeFile(
    "build/problematic-manifests.log",
    problematicManifests.length > 0
      ? `Excluded manifests (${problematicManifests.length}) — generated ${new Date().toISOString()}\n\n${problematicLog}\n`
      : `No excluded manifests — generated ${new Date().toISOString()}\n`,
    "utf-8"
  );

  console.log(`[5/5] Writing build/collection.json (top-level IIIF collection of sub-collections)`);
  // Top-level IIIF v2 collection referencing per-source sub-collections
  // Viewers that support collection nesting can use this to load each source as a layer.
  const topColId = base("collection.json");
  const topCollection = {
    "@context": "http://iiif.io/api/presentation/2/context.json",
    "@id": topColId,
    "@type": "sc:Collection",
    label: "Artemis compiled collection",
    collections: renderLayerMeta.map((l) => ({
      "@id": base(l.compiledCollectionPath),
      "@type": "sc:Collection",
      label: l.renderLayerKey === "verzamelblad"
        ? `${l.sourceCollectionLabel || l.sourceCollectionUrl} - Verzamelblad`
        : l.sourceCollectionLabel || l.sourceCollectionUrl
    }))
  };
  await writeFile("build/collection.json", JSON.stringify(topCollection, null, 2), "utf-8");

  console.log(`Done. sources=${sourceGroups.length}, manifests=${index.length}, georefManifests=${georefManifests}, mirroredOk=${mirroredOk}, compiledOk=${compiledOk}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
