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
  centerLon?: number;
  centerLat?: number;

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

type ProblematicManifest = {
  manifestAllmapsId: string;
  label: string;
  sourceManifestUrl: string;
  reason: string;
  issueTypes: string[];
  annotationPaths: string[];
  potentialSolutions: string[];
  fixAttempted: boolean;
  appliedFixes: string[];
  unresolvedIssues: string[];
};

type AnnotationIssue = {
  code: "mask-out-of-bounds" | "duplicate-geo-gcp" | "tps-low-gcp" | "self-intersecting-mask";
  message: string;
  annotationPath: string;
};

type SuccessfulFixManifest = {
  manifestAllmapsId: string;
  label: string;
  sourceManifestUrl: string;
  annotationPaths: string[];
  issuesBefore: string[];
  appliedFixes: string[];
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

function parseSvgPolygonPoints(svg: string): Array<[number, number]> {
  const m = svg.match(/points="([^"]+)"/);
  if (!m) return [];
  const pairs = m[1].trim().split(/\s+/g);
  const out: Array<[number, number]> = [];
  for (const pair of pairs) {
    const [xRaw, yRaw] = pair.split(",");
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([x, y]);
  }
  return out;
}

function uniqueStrings(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.trim().length > 0))];
}

function summarizeIssues(issues: AnnotationIssue[]): string[] {
  return uniqueStrings(issues.map((x) => `${x.code}: ${x.message}`));
}

function issueSolutionsFor(codes: AnnotationIssue["code"][]): string[] {
  const solutions: string[] = [];
  if (codes.includes("mask-out-of-bounds")) {
    solutions.push("Clamp resource mask polygon points to image bounds (0..width, 0..height).");
  }
  if (codes.includes("duplicate-geo-gcp")) {
    solutions.push("Remove or merge duplicate geographic GCPs in the annotation.");
  }
  if (codes.includes("tps-low-gcp")) {
    solutions.push("For low GCP counts, use polynomial order 1 instead of thinPlateSpline.");
  }
  if (codes.includes("self-intersecting-mask")) {
    solutions.push("Rewrite self-intersecting mask polygons to a valid non-self-intersecting ring (e.g. convex hull fallback).");
  }
  return uniqueStrings(solutions);
}

function serializeSvgPolygonPoints(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

function extractGeoPointsFromMirroredAnnotation(raw: any): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const items = Array.isArray(raw?.items) ? raw.items : [];
  for (const item of items) {
    const features = Array.isArray(item?.body?.features) ? item.body.features : [];
    for (const feature of features) {
      if (feature?.geometry?.type !== "Point") continue;
      const c = feature?.geometry?.coordinates;
      if (!Array.isArray(c) || c.length < 2) continue;
      const lon = Number(c[0]);
      const lat = Number(c[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      out.push([lon, lat]);
    }
  }
  return out;
}

function centerFromGeoPoints(points: Array<[number, number]>): [number, number] | null {
  if (points.length < 1) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

async function deriveAnnotationCenter(
  preferredAnnotationPath: string,
  fallbackAnnotationPaths: string[]
): Promise<[number, number] | null> {
  const readCenter = async (relPath: string): Promise<[number, number] | null> => {
    if (!relPath) return null;
    const absPath = `build/${relPath}`;
    try {
      const raw = JSON.parse(await readFile(absPath, "utf-8"));
      const points = extractGeoPointsFromMirroredAnnotation(raw);
      return centerFromGeoPoints(points);
    } catch {
      return null;
    }
  };

  // Prefer manifest annotation center (aggregated + canonical), then fall back to canvases.
  const preferred = await readCenter(preferredAnnotationPath);
  if (preferred) return preferred;

  const allFallback = uniqueStrings(fallbackAnnotationPaths);
  const merged: Array<[number, number]> = [];
  for (const relPath of allFallback) {
    const absPath = `build/${relPath}`;
    try {
      const raw = JSON.parse(await readFile(absPath, "utf-8"));
      merged.push(...extractGeoPointsFromMirroredAnnotation(raw));
    } catch {
      // ignore bad/missing fallback annotation paths
    }
  }
  return centerFromGeoPoints(merged);
}

function pointKey([x, y]: [number, number]): string {
  return `${x.toFixed(6)},${y.toFixed(6)}`;
}

function normalizePolygon(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length < 2) return points;
  const out: Array<[number, number]> = [];
  for (const p of points) {
    if (out.length === 0 || pointKey(out[out.length - 1]) !== pointKey(p)) out.push(p);
  }
  if (out.length > 2 && pointKey(out[0]) === pointKey(out[out.length - 1])) out.pop();
  return out;
}

function cross(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function onSegment(a: [number, number], b: [number, number], p: [number, number]): boolean {
  const eps = 1e-9;
  return (
    Math.min(a[0], b[0]) - eps <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + eps &&
    Math.min(a[1], b[1]) - eps <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + eps
  );
}

function orientation(a: [number, number], b: [number, number], c: [number, number]): number {
  const v = cross(a, b, c);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : -1;
}

function segmentsIntersect(a1: [number, number], a2: [number, number], b1: [number, number], b2: [number, number]): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, a2, b1)) return true;
  if (o2 === 0 && onSegment(a1, a2, b2)) return true;
  if (o3 === 0 && onSegment(b1, b2, a1)) return true;
  if (o4 === 0 && onSegment(b1, b2, a2)) return true;
  return false;
}

function hasSelfIntersections(pointsInput: Array<[number, number]>): boolean {
  const points = normalizePolygon(pointsInput);
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      const adjacent =
        i === j ||
        (i + 1) % n === j ||
        i === (j + 1) % n;
      if (adjacent) continue;
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function convexHull(pointsInput: Array<[number, number]>): Array<[number, number]> {
  const uniqMap = new Map<string, [number, number]>();
  for (const p of pointsInput) uniqMap.set(pointKey(p), p);
  const points = [...uniqMap.values()].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (points.length <= 2) return points;

  const lower: Array<[number, number]> = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function analyzeMirroredAnnotation(raw: any, annotationPath: string): AnnotationIssue[] {
  const issues: AnnotationIssue[] = [];
  const items = Array.isArray(raw?.items) ? raw.items : [];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const width = Number(item?.target?.source?.width);
    const height = Number(item?.target?.source?.height);
    const selector = item?.target?.selector?.value;
    if (typeof selector === "string" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const points = parseSvgPolygonPoints(selector);
      if (hasSelfIntersections(points)) {
        issues.push({
          code: "self-intersecting-mask",
          message: `item[${idx}] mask polygon is self-intersecting`,
          annotationPath
        });
      }
      const oobCount = points.filter(([x, y]) => x < 0 || y < 0 || x > width || y > height).length;
      if (oobCount > 0) {
        issues.push({
          code: "mask-out-of-bounds",
          message: `item[${idx}] has ${oobCount} resource mask points outside image bounds`,
          annotationPath
        });
      }
    }

    const body = item?.body;
    const features = Array.isArray(body?.features) ? body.features : [];
    const pointFeatures = features.filter((f: any) => f?.geometry?.type === "Point");
    const gcpCount = pointFeatures.length;

    if (body?.transformation?.type === "thinPlateSpline" && gcpCount < 5) {
      issues.push({
        code: "tps-low-gcp",
        message: `item[${idx}] uses thinPlateSpline with only ${gcpCount} GCPs`,
        annotationPath
      });
    }

    const geoKeys = pointFeatures
      .map((f: any) => f?.geometry?.coordinates)
      .filter((c: any) => Array.isArray(c) && c.length >= 2)
      .map((c: any) => `${Number(c[0]).toFixed(12)},${Number(c[1]).toFixed(12)}`);
    const dupGeo = geoKeys.length - new Set(geoKeys).size;
    if (dupGeo > 0) {
      issues.push({
        code: "duplicate-geo-gcp",
        message: `item[${idx}] has ${dupGeo} duplicate geographic GCP(s)`,
        annotationPath
      });
    }
  }
  return issues;
}

function sanitizeMirroredAnnotation(raw: any): { json: any; appliedFixes: string[] } {
  const out = JSON.parse(JSON.stringify(raw));
  const appliedFixes: string[] = [];
  const items = Array.isArray(out?.items) ? out.items : [];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const width = Number(item?.target?.source?.width);
    const height = Number(item?.target?.source?.height);
    const selector = item?.target?.selector;
    if (typeof selector?.value === "string" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const points = parseSvgPolygonPoints(selector.value);
      if (points.length > 0) {
        // [TEST: mask-out-of-bounds passthrough] Clamping intentionally disabled to let
        // out-of-bounds mask points reach the viewer unchanged. This allows confirming
        // whether mask-out-of-bounds is the root cause of viewer rendering failures.
        // TO REVERT: uncomment the clamping block below and remove this comment.
        //
        // let clampedCount = 0;
        // const clamped = points.map(([x, y]) => {
        //   const nx = Math.max(0, Math.min(width, x));
        //   const ny = Math.max(0, Math.min(height, y));
        //   if (nx !== x || ny !== y) clampedCount++;
        //   return [nx, ny] as [number, number];
        // });
        // if (clampedCount > 0) {
        //   selector.value = selector.value.replace(/points="([^"]+)"/, `points="${serializeSvgPolygonPoints(clamped)}"`);
        //   appliedFixes.push(`clamped-mask-points:item[${idx}]:${clampedCount}`);
        // }

        const normalized = normalizePolygon(parseSvgPolygonPoints(selector.value));
        if (hasSelfIntersections(normalized)) {
          const hull = convexHull(normalized);
          if (hull.length >= 3 && !hasSelfIntersections(hull)) {
            selector.value = selector.value.replace(/points="([^"]+)"/, `points="${serializeSvgPolygonPoints(hull)}"`);
            appliedFixes.push(`repaired-self-intersection:item[${idx}]:convex-hull:${normalized.length}->${hull.length}`);
          }
        }
      }
    }

    const body = item?.body;
    const features = Array.isArray(body?.features) ? body.features : [];
    if (features.length > 0) {
      const seenGeo = new Set<string>();
      let removed = 0;
      const deduped: any[] = [];
      for (const f of features) {
        if (f?.geometry?.type !== "Point") {
          deduped.push(f);
          continue;
        }
        const c = f?.geometry?.coordinates;
        if (!Array.isArray(c) || c.length < 2) {
          deduped.push(f);
          continue;
        }
        const key = `${Number(c[0]).toFixed(12)},${Number(c[1]).toFixed(12)}`;
        if (seenGeo.has(key)) {
          removed++;
          continue;
        }
        seenGeo.add(key);
        deduped.push(f);
      }
      if (removed > 0) {
        body.features = deduped;
        appliedFixes.push(`removed-duplicate-geo-gcp:item[${idx}]:${removed}`);
      }
    }

    const pointFeatures = (Array.isArray(body?.features) ? body.features : []).filter((f: any) => f?.geometry?.type === "Point");
    const gcpCount = pointFeatures.length;
    if (body?.transformation?.type === "thinPlateSpline" && gcpCount < 5) {
      body.transformation = { type: "polynomial", options: { order: 1 } };
      appliedFixes.push(`downgraded-tps:item[${idx}]:gcp=${gcpCount}`);
    }
  }
  return { json: out, appliedFixes: uniqueStrings(appliedFixes) };
}

async function collectAnnotationIssues(annotationPaths: string[]): Promise<AnnotationIssue[]> {
  const annotationIssues: AnnotationIssue[] = [];
  for (const relPath of annotationPaths) {
    const absPath = `build/${relPath}`;
    try {
      const raw = JSON.parse(await readFile(absPath, "utf-8"));
      annotationIssues.push(...analyzeMirroredAnnotation(raw, relPath));
    } catch (err: any) {
      console.warn(`[WARN] Could not parse mirrored annotation for QA: ${absPath} (${err?.message ?? err})`);
    }
  }
  return annotationIssues;
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
): Promise<
  | { kind: "ok"; entry: IndexEntry; georef: boolean; mirrored: boolean; compiled: boolean; fixed?: SuccessfulFixManifest }
  | { kind: "problematic"; problematic: ProblematicManifest }
> {
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
  const annotationPathsToCheck = uniqueStrings([
    mirroredManifestRel,
    ...Object.values(mirroredCanvasRelByCanvasId)
  ]);
  const issuesBeforeFix = await collectAnnotationIssues(annotationPathsToCheck);
  let appliedFixes: string[] = [];
  if (issuesBeforeFix.length > 0) {
    for (const relPath of annotationPathsToCheck) {
      const absPath = `build/${relPath}`;
      try {
        const raw = JSON.parse(await readFile(absPath, "utf-8"));
        const sanitized = sanitizeMirroredAnnotation(raw);
        if (sanitized.appliedFixes.length > 0) {
          appliedFixes.push(...sanitized.appliedFixes.map((f) => `${relPath}:${f}`));
          await writeFile(absPath, JSON.stringify(sanitized.json, null, 2), "utf-8");
        }
      } catch (err: any) {
        console.warn(`[WARN] Could not sanitize mirrored annotation: ${absPath} (${err?.message ?? err})`);
      }
    }
    appliedFixes = uniqueStrings(appliedFixes);
  }
  const issuesAfterFix = await collectAnnotationIssues(annotationPathsToCheck);
  // [TEST: mask-out-of-bounds passthrough] mask-out-of-bounds is excluded from the blocking
  // QA gate so manifests with this issue are compiled and included in the build unchanged.
  // This lets the viewer receive the raw OOB annotation data for root-cause testing.
  // TO REVERT: remove the filter line below so all issues block the build again.
  const blockingIssuesAfterFix = issuesAfterFix.filter((x) => x.code !== "mask-out-of-bounds");
  if (blockingIssuesAfterFix.length > 0) {
    const issueCodes = uniqueStrings(blockingIssuesAfterFix.map((x) => x.code)) as AnnotationIssue["code"][];
    const issueMessages = summarizeIssues(blockingIssuesAfterFix);
    console.warn(`[SKIP] Annotation QA failed: ${url} (${manifestAllmapsId}) -> ${issueCodes.join(", ")}`);
    return {
      kind: "problematic",
      problematic: {
        manifestAllmapsId,
        label: (man.label ?? label ?? "").toString(),
        sourceManifestUrl: url,
        reason: issueMessages.join(" | "),
        issueTypes: issueCodes,
        annotationPaths: uniqueStrings(issuesAfterFix.map((x) => x.annotationPath)),
        potentialSolutions: issueSolutionsFor(issueCodes)
          .concat(appliedFixes.length > 0 ? ["Review applied local auto-fixes and re-validate in viewer."] : []),
        fixAttempted: issuesBeforeFix.length > 0,
        appliedFixes,
        unresolvedIssues: issueMessages
      }
    };
  }

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

  const fixedManifest: SuccessfulFixManifest | undefined =
    issuesBeforeFix.length > 0
      ? {
          manifestAllmapsId,
          label: (man.label ?? label ?? "").toString(),
          sourceManifestUrl: url,
          annotationPaths: annotationPathsToCheck,
          issuesBefore: summarizeIssues(issuesBeforeFix),
          appliedFixes
        }
      : undefined;

  const center = await deriveAnnotationCenter(
    mirroredManifestRel,
    Object.values(mirroredCanvasRelByCanvasId)
  );

  return {
    kind: "ok",
    entry: {
      label: (man.label ?? label ?? "").toString(),
      sourceManifestUrl: url,
      sourceCollectionUrl,
      ...(center ? { centerLon: center[0], centerLat: center[1] } : {}),
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
    compiled: didCompile,
    fixed: fixedManifest
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
  // Remove legacy QA logs; report.log is now the single consolidated output.
  for (const file of ["build/fixed-manifests.log", "build/problematic-manifests.log", "build/report.log"]) {
    await rm(file, { force: true });
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
  const fixedManifests: SuccessfulFixManifest[] = [];
  const problematicManifests: ProblematicManifest[] = [];
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
        console.warn(`[WARN] Known problematic manifest entering auto-fix path: ${ref.url} (${checkId})`);
      }

      const result = await processManifestRef(
        ref,
        group.sourceCollectionUrl,
        buildBaseUrl,
        i,
        slice.length
      );
      if (result.kind === "problematic") {
        problematicManifests.push(result.problematic);
        continue;
      }
      index.push(result.entry);
      if (result.fixed) fixedManifests.push(result.fixed);
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
    renderLayerKey: "default" | "verzamelblad";
    compiledCollectionPath: string;
    manifestCount: number;
    georefCount: number;
    singleCanvasGeorefCount: number;
    multiCanvasGeorefCount: number;
    hidden: false;
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
    fixedManifests,
    problematicManifests,
    index
  };
  await writeFile("build/index.json", JSON.stringify(indexOut, null, 2), "utf-8");

  const problematicLog = problematicManifests.map((m) =>
    [
      `[SKIP] ${m.manifestAllmapsId}  ${m.label}`,
      `       ${m.sourceManifestUrl}`,
      `       reason: ${m.reason}`,
      `       issueTypes: ${m.issueTypes.join(", ") || "-"}`,
      `       annotationPaths: ${m.annotationPaths.join(", ") || "-"}`,
      `       potentialSolutions: ${m.potentialSolutions.join(" | ") || "-"}`
    ].join("\n")
  ).join("\n");
  const fixedLog = fixedManifests.map((m) =>
    [
      `[FIXED] ${m.manifestAllmapsId}  ${m.label}`,
      `       ${m.sourceManifestUrl}`,
      `       issuesBefore: ${m.issuesBefore.join(" | ") || "-"}`,
      `       annotationPaths: ${m.annotationPaths.join(", ") || "-"}`,
      `       appliedFixes: ${m.appliedFixes.join(" | ") || "-"}`
    ].join("\n")
  ).join("\n");
  await writeFile(
    "build/report.log",
    [
      `Annotation QA report — generated ${new Date().toISOString()}`,
      "",
      `Fixed manifests: ${fixedManifests.length}`,
      fixedManifests.length > 0 ? `\n${fixedLog}` : "  (none)",
      "",
      `Excluded manifests: ${problematicManifests.length}`,
      problematicManifests.length > 0 ? `\n${problematicLog}` : "  (none)",
      ""
    ].join("\n"),
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
