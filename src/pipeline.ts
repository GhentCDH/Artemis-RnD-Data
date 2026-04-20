import { mkdir, readFile, writeFile, stat, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { parseAnnotation, validateGeoreferencedMap } from "@allmaps/annotation";
import { generateId } from "@allmaps/id";
import { Image } from "@allmaps/iiif-parser";
import sharp from "sharp";
import { iiifSourceUrls, readSourceRegistry } from "./registry";
import { createSimplifier, getSimplificationConfig } from "./simplify";

// FLAG: set INCLUDE_NON_GEOREF=1 to also compile and include non-georeferenced manifests.
// By default only georeferenced manifests are compiled and listed in collections.
const INCLUDE_NON_GEOREF = !!process.env.INCLUDE_NON_GEOREF;
const simplifyMask = createSimplifier(getSimplificationConfig());

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

type SpriteFailure = {
  mapId: string;
  manifestId: string;
  manifestLabel: string;
  canvasId: string;
  canvasAllmapsId: string;
  serviceId: string;
  reason: string;
};

// ---------------------------------------------------------------------------
// UGent Primo source — resolved at crawl time via API (no data/sources file)
// ---------------------------------------------------------------------------

const UGENT_PRIMO_BASE = "https://libcatalog.ugent.be/primaws/rest/pub";
const UGENT_IIIF_BASE = "https://libcatalog.ugent.be";
const UGENT_VID = "32RUG_INST:32RUG_INST";
const UGENT_INST = "32RUG_INST";

type UgentMassartItem = {
  title: string;
  year?: string;
  location?: string;
  lat?: number;
  lon?: number;
  manifestUrl: string;
  mmsId: string;
  repId: string;
};

async function fetchUgentJson(url: string, method: "GET" | "POST" = "GET"): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Origin: "https://libcatalog.ugent.be",
      Referer: "https://libcatalog.ugent.be/nde/search",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  if (!res.ok) throw new Error(`UGent API ${res.status} ${method} ${url}`);
  return res.json();
}

function buildPrimoParams(offset: number): string {
  return new URLSearchParams({
    citationTrailFilterByAvailability: "true", limit: "10", newspapersActive: "false",
    newspapersSearch: "false", offset: String(offset), pcAvailability: "false",
    scope: "MyInst_and_CI", searchInFulltextUserSelection: "false", disableCache: "false",
    skipDelivery: "Y", sort: "rank", tab: "Everything", inst: UGENT_INST,
    rapido: "true", refEntryActive: "true", rtaLinks: "true", qInclude: "", qExclude: "",
    multiFacets: "facet_rtype,include,images", mode: "advanced",
    q: "creator,contains,Massart, Jean", isCDSearch: "false",
    featuredNewspapersIssnList: "", lang: "en", explain: "", otbRanking: "",
    isRelatedItems: "false", vid: UGENT_VID,
  }).toString();
}

// Parse DMS coordinates embedded in Primo titles.
// Format: "51°10'11" NB 04°11'51" OL" (NB=lat N, ZB=lat S, OL=lon E, WL=lon W)
function parseDmsFromTitle(title: string): { lat: number; lon: number } | null {
  const m = title.match(/(\d+)°(\d+)'(\d+)[""″]\s*(NB|ZB)\s+(\d+)°(\d+)'(\d+)[""″]\s*(OL|WL)/);
  if (!m) return null;
  const lat = parseInt(m[1]) + parseInt(m[2]) / 60 + parseInt(m[3]) / 3600;
  const lon = parseInt(m[5]) + parseInt(m[6]) / 60 + parseInt(m[7]) / 3600;
  return { lat: m[4] === "ZB" ? -lat : lat, lon: m[8] === "WL" ? -lon : lon };
}

async function resolveUgentMassartSource(limit?: number): Promise<{ group: SourceGroup; items: UgentMassartItem[] }> {
  const first = await fetchUgentJson(`${UGENT_PRIMO_BASE}/pnxs?${buildPrimoParams(0)}`);
  const total = first.info?.total ?? 0;
  console.log(`    ${total} records found in Primo`);

  const offsets = Array.from({ length: Math.ceil(total / 10) }, (_, i) => i * 10);
  const allDocs: any[] = [...(first.docs ?? [])];
  for (const offset of offsets.slice(1)) {
    const page = await fetchUgentJson(`${UGENT_PRIMO_BASE}/pnxs?${buildPrimoParams(offset)}`);
    allDocs.push(...(page.docs ?? []));
  }

  const docsToProcess = typeof limit === "number" ? allDocs.slice(0, limit) : allDocs;
  const items: UgentMassartItem[] = [];
  const refs: Array<{ url: string; label: string }> = [];

  // Fetch rep IDs in small parallel batches (directLink is POST-only)
  const BATCH = 5;
  for (let i = 0; i < docsToProcess.length; i += BATCH) {
    const batch = docsToProcess.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (doc) => {
      const display = doc.pnx?.display ?? {};
      const recordId: string = doc.pnx?.control?.recordid?.[0];
      if (!recordId) return null;
      const rawTitle: string = display.title?.[0] ?? "";
      const year = display.creationdate?.[0]?.match(/\b(\d{4})\b/)?.[1];
      const geo = (display.subject as string[] | undefined)?.find((s) => s.startsWith("België "));
      const location = geo?.replace("België ", "").trim();
      const coords = parseDmsFromTitle(rawTitle);
      const link = await fetchUgentJson(
        `${UGENT_PRIMO_BASE}/directLink/${recordId}?lang=en&vid=${UGENT_VID}`, "POST"
      ).catch(() => null);
      if (!link?.full_text_do_redirect || !link?.redirect_to) return null;
      const repId = (link.redirect_to as string).match(/\/(\d+)$/)?.[1];
      if (!repId) return null;
      const manifestUrl = `${UGENT_IIIF_BASE}/view/iiif/presentation/${UGENT_INST}/${repId}/manifest?iiifVersion=2&updateStatistics=false`;
      const displayTitle = normalizeMassartTitle(rawTitle);
      return { title: displayTitle, year, location, lat: coords?.lat, lon: coords?.lon, manifestUrl, mmsId: recordId, repId };
    }));
    for (const r of results) {
      if (!r) continue;
      items.push(r);
      refs.push({ url: r.manifestUrl, label: r.title });
    }
    if (i + BATCH < docsToProcess.length) await new Promise((res) => setTimeout(res, 100));
  }

  console.log(`    ${items.length} digitized manifests resolved`);
  return {
    group: { sourceCollectionUrl: "ugent://massart", sourceCollectionLabel: "Jean Massart photographs — Universiteit Gent", refs },
    items,
  };
}

function normalizeMassartTitle(rawTitle: string): string {
  const trimmed = rawTitle.trim();
  if (!trimmed) return trimmed;

  const withoutPhotograph = trimmed
    .replace(/\s*\/\s*\[photograph\]\s*$/i, "")
    .trim();

  const withoutBracketedCatalogSuffix = withoutPhotograph
    .replace(/\s*:\s*\[[^\]]*\]\s*$/u, "")
    .trim();

  return withoutBracketedCatalogSuffix || withoutPhotograph || trimmed;
}

type IndexEntry = {
  label: string;
  sourceManifestUrl: string;
  sourceCollectionUrl: string;
  sourceCollectionLabel: string;  // [Phase B] Map label for quick lookup
  canvasCount: number;
  isVerzamelblad: boolean;
  compiledManifestPath: string; // "" when non-georef and INCLUDE_NON_GEOREF=false
  // Present only for georef manifests:
  centerLon?: number;
  centerLat?: number;
  manifestAllmapsId?: string;
  georefDetectedBy?: "canvas" | "manifest" | "both";
  annotSource?: "single" | "multi";
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
  maskPointsPruned: number;
  duplicateGcpsPruned: number;
};

type AnnotationPruneStats = {
  maskPointsPruned: number;
  duplicateGcpsPruned: number;
};

// Manifests with self-intersecting resource masks — excluded from build.
// These cause CDT triangulation failures in Allmaps (Edge intersects already constrained edge).
const PROBLEMATIC_MANIFEST_IDS = new Set([
  "04930d7222f43159", // ANTWERPEN - Verzamelplan
  "787106327b287f41", // ANTWERPEN - Sectie B
  "949c44555577f899", // ANTWERPEN - Sectie C
  "e621fad69cecfcb5", // Kalken - Sectie B
]);

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

function extractGeoPointsFromGeoreferencedMap(raw: any): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const gcps = Array.isArray(raw?.gcps) ? raw.gcps : [];
  for (const gcp of gcps) {
    const c = gcp?.geo;
    if (!Array.isArray(c) || c.length < 2) continue;
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push([lon, lat]);
  }
  return out;
}

function extractGeoPointsFromAnnotationPage(raw: any): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const items = Array.isArray(raw?.items) ? raw.items : [];
  for (const item of items) {
    const body = item?.body;
    const features = Array.isArray(body?.features) ? body.features : [];
    for (const feature of features) {
      const resource = feature?.properties?.resourceCoords;
      const geo = feature?.geometry?.coordinates;
      if (!Array.isArray(resource) || resource.length < 2) continue;
      if (!Array.isArray(geo) || geo.length < 2) continue;
      const lon = Number(geo[0]);
      const lat = Number(geo[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      out.push([lon, lat]);
    }
  }
  return out;
}

function extractGeoPointsFromAnyAnnotation(raw: any): Array<[number, number]> {
  if (!raw || typeof raw !== "object") return [];
  if (raw.type === "AnnotationPage") return extractGeoPointsFromAnnotationPage(raw);
  return extractGeoPointsFromGeoreferencedMap(raw);
}

function centerFromGeoPoints(points: Array<[number, number]>): [number, number] | null {
  if (points.length < 1) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

async function deriveAnnotationCenter(canvasAnnotationPaths: string[]): Promise<[number, number] | null> {
  const merged: Array<[number, number]> = [];
  for (const relPath of uniqueStrings(canvasAnnotationPaths)) {
    try {
      const raw = JSON.parse(await readFile(`.build-cache/${relPath}`, "utf-8"));
      merged.push(...extractGeoPointsFromAnyAnnotation(raw));
    } catch {
      // ignore bad/missing paths
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
      const adjacent = i === j || (i + 1) % n === j || i === (j + 1) % n;
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
  const width = Number(raw?.resource?.width);
  const height = Number(raw?.resource?.height);
  const mask = Array.isArray(raw?.resourceMask) ? raw.resourceMask : [];
  if (mask.length > 0 && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    if (hasSelfIntersections(mask)) {
      issues.push({ code: "self-intersecting-mask", message: "resourceMask polygon is self-intersecting", annotationPath });
    }
    const oobCount = mask.filter(([x, y]: [number, number]) => x < 0 || y < 0 || x > width || y > height).length;
    if (oobCount > 0) {
      issues.push({ code: "mask-out-of-bounds", message: `resourceMask has ${oobCount} points outside image bounds`, annotationPath });
    }
  }
  const gcps = Array.isArray(raw?.gcps) ? raw.gcps : [];
  if (raw?.transformation?.type === "thinPlateSpline" && gcps.length < 5) {
    issues.push({ code: "tps-low-gcp", message: `uses thinPlateSpline with only ${gcps.length} GCPs`, annotationPath });
  }
  const geoKeys = gcps
    .map((gcp: any) => gcp?.geo)
    .filter((c: any) => Array.isArray(c) && c.length >= 2)
    .map((c: any) => `${Number(c[0]).toFixed(12)},${Number(c[1]).toFixed(12)}`);
  const dupGeo = geoKeys.length - new Set(geoKeys).size;
  if (dupGeo > 0) {
    issues.push({ code: "duplicate-geo-gcp", message: `has ${dupGeo} duplicate geographic GCP(s)`, annotationPath });
  }
  return issues;
}

function sanitizeMirroredAnnotation(raw: any): { json: any; appliedFixes: string[]; stats: AnnotationPruneStats } {
  const out = JSON.parse(JSON.stringify(raw));
  const appliedFixes: string[] = [];
  const stats: AnnotationPruneStats = { maskPointsPruned: 0, duplicateGcpsPruned: 0 };
  const width = Number(out?.resource?.width);
  const height = Number(out?.resource?.height);
  if (Array.isArray(out?.resourceMask) && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    let clampedCount = 0;
    out.resourceMask = out.resourceMask.map(([x, y]: [number, number]) => {
      const nx = Math.max(0, Math.min(width, x));
      const ny = Math.max(0, Math.min(height, y));
      if (nx !== x || ny !== y) clampedCount++;
      return [nx, ny] as [number, number];
    });
    if (clampedCount > 0) appliedFixes.push(`clamped-mask-points:${clampedCount}`);
    let normalized = normalizePolygon(out.resourceMask);

    // First attempt: gentle simplification (works even on self-intersecting polygons)
    let simplified = simplifyMask(normalized, width, height);
    if (simplified.length >= 3 && simplified.length < normalized.length) {
      stats.maskPointsPruned += normalized.length - simplified.length;
      appliedFixes.push(`simplified-mask:${normalized.length}->${simplified.length}`);
      normalized = simplified;
    }

    // Second attempt: if still self-intersecting, try convex hull as last resort
    if (hasSelfIntersections(normalized)) {
      const originalLength = normalized.length;
      const hull = convexHull(normalized);
      if (hull.length >= 3 && !hasSelfIntersections(hull)) {
        normalized = hull;
        appliedFixes.push(`repaired-self-intersection:convex-hull:${originalLength}->${hull.length}`);
      }
    }

    out.resourceMask = normalized;
  }
  if (Array.isArray(out?.gcps) && out.gcps.length > 0) {
    const seenGeo = new Set<string>();
    let removed = 0;
    out.gcps = out.gcps.filter((gcp: any) => {
      const c = gcp?.geo;
      if (!Array.isArray(c) || c.length < 2) return true;
      const key = `${Number(c[0]).toFixed(12)},${Number(c[1]).toFixed(12)}`;
      if (seenGeo.has(key)) { removed++; return false; }
      seenGeo.add(key);
      return true;
    });
    if (removed > 0) {
      stats.duplicateGcpsPruned += removed;
      appliedFixes.push(`removed-duplicate-geo-gcp:${removed}`);
    }
  }
  if (out?.transformation?.type === "thinPlateSpline" && Array.isArray(out?.gcps) && out.gcps.length < 5) {
    out.transformation = { type: "polynomial", options: { order: 1 } };
    appliedFixes.push(`downgraded-tps:gcp=${out.gcps.length}`);
  }
  return { json: out, appliedFixes: uniqueStrings(appliedFixes), stats };
}

async function collectAnnotationIssues(annotationPaths: string[]): Promise<AnnotationIssue[]> {
  const annotationIssues: AnnotationIssue[] = [];
  for (const relPath of annotationPaths) {
    try {
      const raw = JSON.parse(await readFile(`.build-cache/${relPath}`, "utf-8"));
      annotationIssues.push(...analyzeMirroredAnnotation(raw, relPath));
    } catch (err: any) {
      console.warn(`[WARN] Could not parse mirrored annotation for QA: .build-cache/${relPath} (${err?.message ?? err})`);
    }
  }
  return annotationIssues;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function fetchJson(url: string): Promise<any> {
  // Support local file paths (relative or file://) in addition to HTTP URLs
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    const localPath = url.startsWith("file://") ? url.slice(7) : url;
    return JSON.parse(await readFile(localPath, "utf-8"));
  }
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return await res.json();
}

async function cachedJson(url: string, cacheDir: string): Promise<any> {
  await mkdir(cacheDir, { recursive: true });
  const path = `${cacheDir}/${sha1(url)}.json`;
  if (await exists(path)) return JSON.parse(await readFile(path, "utf-8"));
  const json = await fetchJson(url);
  await writeFile(path, JSON.stringify(json, null, 2), "utf-8");
  return json;
}

function listManifestRefs(collection: V2Collection): Array<{ url: string; label: string }> {
  return (collection.manifests ?? [])
    .map((m) => ({ url: (m["@id"] ?? "").toString(), label: (m.label ?? "").toString() }))
    .filter((m) => m.url.length > 0);
}

function extractCanvasIdsFromV2Manifest(man: V2Manifest): string[] {
  return (man?.sequences?.[0]?.canvases ?? [])
    .map((c: any) => (c?.["@id"] ?? "").toString())
    .filter((id: string) => id.length > 0);
}

function extractCanvasImageServices(man: V2Manifest): Record<string, string> {
  const result: Record<string, string> = {};
  for (const canvas of man?.sequences?.[0]?.canvases ?? []) {
    const canvasId = (canvas?.["@id"] ?? "").toString();
    if (!canvasId) continue;
    for (const image of Array.isArray(canvas?.images) ? canvas.images : []) {
      const svc = image?.resource?.service;
      const serviceId = svc?.["@id"] ?? (Array.isArray(svc) ? svc[0]?.["@id"] : null);
      if (serviceId) { result[canvasId] = serviceId.toString(); break; }
    }
  }
  return result;
}

async function storeRawCanvasAnnotation(canvasAllmapsId: string, annotation: unknown): Promise<string> {
  const outAbs = `.build-cache/allmaps/raw-canvases/${canvasAllmapsId}.json`;
  const outRel = `allmaps/raw-canvases/${canvasAllmapsId}.json`;
  await writeFile(outAbs, JSON.stringify(annotation, null, 2), "utf-8");
  return outRel;
}

async function fetchRawGeoreferencedMap(candidate: any): Promise<any | null> {
  const mapId = String(candidate?.id ?? "").trim();
  if (!mapId) return null;
  try {
    const raw = await cachedJson(mapId, ".build-cache/allmaps");
    const validated = validateGeoreferencedMap(raw);
    return Array.isArray(validated) ? validated[0] : validated;
  } catch {
    return null;
  }
}

async function loadRawAnnotationCache(): Promise<Map<string, any>> {
  const byCanvasId = new Map<string, any>();
  let loadedCanvasesFromRawCache = 0;
  let loadedCanvasesFromLegacyCache = 0;
  let loadedCanvasesFromGeomaps = 0;
  let loadedMapsFromGeomaps = 0;
  let geomapsFiles = 0;

  // Primary bootstrap source: persistent raw Allmaps annotations per canvas.
  try {
    const entries = await readdir(".build-cache/allmaps/raw-canvases", { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();

    for (const file of files) {
      try {
        const raw = JSON.parse(await readFile(join(".build-cache/allmaps/raw-canvases", file), "utf-8"));
        const validated = validateGeoreferencedMap(raw);
        const georeferencedMap = Array.isArray(validated) ? validated[0] : validated;
        const canvasId = String(georeferencedMap?.resource?.partOf?.[0]?.id ?? "").trim();
        if (!canvasId || byCanvasId.has(canvasId)) continue;
        byCanvasId.set(canvasId, georeferencedMap);
        loadedCanvasesFromRawCache++;
      } catch {
        // Ignore malformed cache entries and continue loading the rest.
      }
    }
  } catch {
    // No raw cache yet — fall through to compatibility imports.
  }

  // Compatibility import: legacy sanitized canvas cache. Rehydrate raw cache by
  // refetching the canonical Allmaps map JSON through its stable annotation ID.
  try {
    const entries = await readdir(".build-cache/allmaps/canvases", { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();

    for (const file of files) {
      try {
        const cached = JSON.parse(await readFile(join(".build-cache/allmaps/canvases", file), "utf-8"));
        const validated = validateGeoreferencedMap(cached);
        const georeferencedMap = Array.isArray(validated) ? validated[0] : validated;
        const canvasId = String(georeferencedMap?.resource?.partOf?.[0]?.id ?? "").trim();
        if (!canvasId || byCanvasId.has(canvasId)) continue;
        const rawGeoreferencedMap = await fetchRawGeoreferencedMap(georeferencedMap);
        const chosen = rawGeoreferencedMap ?? georeferencedMap;
        byCanvasId.set(canvasId, chosen);
        const canvasAllmapsId = await generateId(canvasId);
        await storeRawCanvasAnnotation(canvasAllmapsId, chosen);
        loadedCanvasesFromLegacyCache++;
      } catch {
        // Ignore malformed legacy cache entries and continue loading the rest.
      }
    }
  } catch {
    // No legacy cache available.
  }

  // NOTE: Removed secondary bootstrap from build/IIIF/*_geomaps.json (2026-04-17)
  // This created a circular dependency: relying on output files to bootstrap input.
  // The correct pattern is: persistent .build-cache/ bootstraps itself, build/ is pure output.
  // On a fresh run or after deleting .build-cache, no annotations will be found until:
  // 1. Cache is manually seeded with previously published geomaps, OR
  // 2. Fallback to fetch from Allmaps API is implemented (TODO)
  // For now, rely entirely on .build-cache/allmaps/ and .build-cache/collections/

  if (byCanvasId.size > 0) {
    console.log(
      `  Georef bootstrap cache: ${byCanvasId.size} canvases ` +
      `(.build-cache/raw=${loadedCanvasesFromRawCache}, .build-cache/legacy=${loadedCanvasesFromLegacyCache}, geomaps=${loadedCanvasesFromGeomaps} from ${geomapsFiles} bundle(s) / ${loadedMapsFromGeomaps} maps)`
    );
  } else {
    console.log("  Georef bootstrap cache: empty");
  }
  return byCanvasId;
}

async function storeCanvasAnnotation(canvasAllmapsId: string, annotation: unknown): Promise<string> {
  const outAbs = `.build-cache/allmaps/canvases/${canvasAllmapsId}.json`;
  const outRel = `allmaps/canvases/${canvasAllmapsId}.json`;
  await writeFile(outAbs, JSON.stringify(annotation, null, 2), "utf-8");
  return outRel;
}

/**
 * Mirror a canvas-level Allmaps annotation to .build-cache/allmaps/canvases/<id>.json.
 * Fetches from https://annotations.allmaps.org/canvases/{canvasAllmapsId} if not cached.
 */
async function mirrorCanvasAnnotation(canvasAllmapsId: string): Promise<{ status: number; relPath: string }> {
  const outAbs = `.build-cache/allmaps/canvases/${canvasAllmapsId}.json`;
  const outRel = `allmaps/canvases/${canvasAllmapsId}.json`;
  if (await exists(outAbs)) return { status: 200, relPath: outRel };

  try {
    const res = await fetch(`https://annotations.allmaps.org/canvases/${canvasAllmapsId}`, { redirect: "follow" });
    if (res.status !== 200) return { status: res.status, relPath: "" };

    const json = await res.json();
    await writeFile(outAbs, JSON.stringify(json, null, 2), "utf-8");
    return { status: 200, relPath: outRel };
  } catch (err) {
    console.warn(`[WARN] Failed to fetch canvas annotation from Allmaps: ${canvasAllmapsId} (${err instanceof Error ? err.message : err})`);
    return { status: 0, relPath: "" };
  }
}

/**
 * For canvases with no standalone canvas annotation in Allmaps (canvas endpoint → 404),
 * fetch the manifest-level annotation and extract each canvas's items into .build-cache/.
 */
async function fillUncoveredCanvasAnnotations(
  manifestAllmapsId: string,
  uncovered: Array<{ canvasId: string; canvasAllmapsId: string; imageServiceUrl: string }>
): Promise<Record<string, string>> {
  if (uncovered.length === 0) return {};

  const result: Record<string, string> = {};
  const needExtract: typeof uncovered = [];

  for (const c of uncovered) {
    const outAbs = `.build-cache/allmaps/canvases/${c.canvasAllmapsId}.json`;
    if (await exists(outAbs)) {
      result[c.canvasId] = `allmaps/canvases/${c.canvasAllmapsId}.json`;
    } else {
      needExtract.push(c);
    }
  }

  if (needExtract.length === 0) return result;

  try {
    const res = await fetch(`https://annotations.allmaps.org/manifests/${manifestAllmapsId}`, { redirect: "follow" });
    if (res.status !== 200) return result;

    const manifestAnnotation = await res.json();
    const items: any[] = Array.isArray(manifestAnnotation?.items) ? manifestAnnotation.items : [];

    for (const { canvasId, canvasAllmapsId, imageServiceUrl } of needExtract) {
      const normalizedUrl = imageServiceUrl.replace(/\/+$/, "");
      const matching = items.filter((item: any) => {
        const src = item?.target?.source;
        const srcId = (typeof src === "string" ? src : src?.id) ?? "";
        return srcId.replace(/\/+$/, "") === normalizedUrl;
      });
      if (matching.length === 0) continue;

      const synthetic = {
        id: `https://annotations.allmaps.org/canvases/${canvasAllmapsId}`,
        type: "AnnotationPage",
        "@context": "http://www.w3.org/ns/anno.jsonld",
        items: matching
      };
      await mkdir(dirname(`.build-cache/allmaps/canvases/${canvasAllmapsId}.json`), { recursive: true });
      await writeFile(`.build-cache/allmaps/canvases/${canvasAllmapsId}.json`, JSON.stringify(synthetic, null, 2), "utf-8");
      result[canvasId] = `allmaps/canvases/${canvasAllmapsId}.json`;
    }
  } catch (err) {
    console.warn(`[WARN] Failed to fetch manifest annotation from Allmaps: ${manifestAllmapsId} (${err instanceof Error ? err.message : err})`);
  }

  return result;
}

/**
 * Prepare manifest for compilation: add pipeline metadata.
 * Georeferencing data is accessed client-side from consolidated geomaps bundles.
 */
function compileV2Manifest(source: V2Manifest): V2Manifest {
  const out: V2Manifest = JSON.parse(JSON.stringify(source));
  out.metadata = Array.isArray(out.metadata) ? out.metadata : [];
  out.metadata.push({ label: "Artemis pipeline", value: "Compiled manifest with consolidated Allmaps georeferencing" });
  return out;
}

function hasVerzamelbladIdentifier(man: V2Manifest, url: string, label: string): boolean {
  const blob = [url, label, (man?.["@id"] ?? "").toString(), (man?.label ?? "").toString(),
    JSON.stringify(man?.identifier ?? ""), JSON.stringify(man?.metadata ?? "")].join(" ");
  return /\bverzamel(?:blad|plan(?:nen)?)\b/i.test(blob);
}

function normalizeSourceCollectionLabel(label: string): string {
  return label.replace(/^\s*artemis\s*[-–—:]\s*/i, "").trim();
}

/**
 * Map a source collection URL to a PascalCase map ID from registry.
 * Uses the registry.json mainLayers and imageCollections structure to find the correct ID.
 * Returns null if no mapping found (e.g., service-backed WMTS/WMS sources).
 */
function deriveMapId(sourceCollectionUrl: string, sourceCollectionLabel: string, registry: any): string | null {
  // Check mainLayers for IIIF sublayers with matching source URL
  for (const mainLayer of registry.mainLayers || []) {
    for (const sublayer of mainLayer.sublayers || []) {
      if (sublayer.kind === "iiif" && sublayer.source?.url === sourceCollectionUrl) {
        return mainLayer.id;  // e.g., "PrimitiefKadaster", "GereduceerdeKadaster"
      }
    }
  }

  // Check imageCollections for IIIF collections with matching source URL
  for (const imgCollection of registry.imageCollections || []) {
    if (imgCollection.kind === "iiif" && imgCollection.source?.url === sourceCollectionUrl) {
      return imgCollection.id;  // e.g., "Massart"
    }
  }

  // Handle Hand Drawn Collection (has no explicit IIIF source URL in registry)
  if (sourceCollectionLabel.toLowerCase().includes("hand") ||
      sourceCollectionUrl.toLowerCase().includes("hand") ||
      sourceCollectionLabel.toLowerCase().includes("drawn")) {
    return "HanddrawnCollection";
  }

  return null;  // No mapping found — this is a service-backed (WMTS/WMS) source
}

async function resolveSourceGroup(collectionUrl: string): Promise<SourceGroup> {
  const json = (await cachedJson(collectionUrl, ".build-cache/collections")) as V2Collection;
  const label = normalizeSourceCollectionLabel((json.label ?? "").toString());
  let refs = listManifestRefs(json);
  if (refs.length === 0) refs = [{ url: collectionUrl, label }];
  const seen = new Set<string>();
  refs = refs.filter(({ url }) => { if (seen.has(url)) return false; seen.add(url); return true; });
  return { sourceCollectionUrl: collectionUrl, sourceCollectionLabel: label, refs };
}

async function processManifestRef(
  { url, label }: { url: string; label: string },
  sourceCollectionUrl: string,
  sourceCollectionLabel: string,
  i: number,
  total: number,
  existingCanvasInfoIds: Set<string>,
  rawAnnotationsByCanvas: Map<string, any>
): Promise<
  | { kind: "ok"; entry: IndexEntry; georef: boolean; compiled: boolean; fixed?: SuccessfulFixManifest; pruneStats: AnnotationPruneStats; canvasInfoEntries: Record<string, any> }
  | { kind: "problematic"; problematic: ProblematicManifest }
> {
  console.log(`  - [${i + 1}/${total}] ${label || "(no label)"} :: ${url}`);

  const man = (await cachedJson(url, ".build-cache/manifests")) as V2Manifest;
  const canvasIds = extractCanvasIdsFromV2Manifest(man);
  const isVerzamelblad = hasVerzamelbladIdentifier(man, url, label);
  const manifestAllmapsId = await generateId(url);

  // Resolve georef annotations: first try pre-loaded cache, then fetch from Allmaps.
  const mirroredCanvasRelByCanvasId: Record<string, string> = {};
  let cachedCanvasHits = 0;
  let fetchedFromAllmaps = 0;
  let uncoveredCount = 0;

  for (const canvasId of canvasIds) {
    const canvasAllmapsId = await generateId(canvasId);

    // Try pre-loaded cache first
    const cachedAnnotation = rawAnnotationsByCanvas.get(canvasId);
    if (cachedAnnotation) {
      mirroredCanvasRelByCanvasId[canvasId] = await storeCanvasAnnotation(canvasAllmapsId, cachedAnnotation);
      cachedCanvasHits++;
      continue;
    }

    // Try to fetch from Allmaps if not in cache
    const mirror = await mirrorCanvasAnnotation(canvasAllmapsId);
    if (mirror.status === 200 && mirror.relPath) {
      mirroredCanvasRelByCanvasId[canvasId] = mirror.relPath;
      fetchedFromAllmaps++;
      continue;
    }

    // Not found yet, will try manifest-level extraction below
    uncoveredCount++;
  }

  // For canvases with no standalone canvas annotation, try extracting from manifest-level annotation
  const uncoveredCanvasIds = canvasIds.filter((id) => !mirroredCanvasRelByCanvasId[id]);
  let manifestExtractedHits = 0;
  if (uncoveredCanvasIds.length > 0) {
    const canvasImageServices = extractCanvasImageServices(man);
    const uncovered: Array<{ canvasId: string; canvasAllmapsId: string; imageServiceUrl: string }> = [];

    for (const canvasId of uncoveredCanvasIds) {
      const canvasAllmapsId = await generateId(canvasId);
      const imageServiceUrl = canvasImageServices[canvasId] ?? "";
      if (imageServiceUrl && canvasAllmapsId) {
        uncovered.push({ canvasId, canvasAllmapsId, imageServiceUrl });
      }
    }

    if (uncovered.length > 0) {
      const extracted = await fillUncoveredCanvasAnnotations(manifestAllmapsId, uncovered);
      for (const [canvasId, relPath] of Object.entries(extracted)) {
        mirroredCanvasRelByCanvasId[canvasId] = relPath;
        manifestExtractedHits++;
      }
    }
  }

  if (cachedCanvasHits > 0 || fetchedFromAllmaps > 0 || manifestExtractedHits > 0) {
    console.log(`    georef resolved: cache=${cachedCanvasHits}, allmaps=${fetchedFromAllmaps}, manifest=${manifestExtractedHits}/${canvasIds.length}`);
  }

  const georefDetected = Object.keys(mirroredCanvasRelByCanvasId).length > 0;
  const georefDetectedBy: IndexEntry["georefDetectedBy"] = !georefDetected
    ? undefined
    : cachedCanvasHits > 0 || fetchedFromAllmaps > 0
      ? "canvas"
      : manifestExtractedHits > 0
        ? "manifest"
        : undefined;

  // Non-georef manifest: slim index entry, skip compiled manifest (unless flag is set).
  if (!georefDetected) {
    const compiledManifestPath = INCLUDE_NON_GEOREF ? `manifests/${sha1(url).slice(0, 16)}.json` : "";
    if (INCLUDE_NON_GEOREF) {
      await writeFile(`build/${compiledManifestPath}`, JSON.stringify(man, null, 2), "utf-8");
    }
    return {
      kind: "ok",
      entry: { label: (man.label ?? label ?? "").toString(), sourceManifestUrl: url, sourceCollectionUrl, sourceCollectionLabel, canvasCount: canvasIds.length, isVerzamelblad, compiledManifestPath },
      georef: false,
      compiled: INCLUDE_NON_GEOREF,
      pruneStats: { maskPointsPruned: 0, duplicateGcpsPruned: 0 },
      canvasInfoEntries: {}
    };
  }

  // Georef path: QA, sanitize, compile.
  const annotationPathsToCheck = uniqueStrings(Object.values(mirroredCanvasRelByCanvasId));
  const issuesBeforeFix = await collectAnnotationIssues(annotationPathsToCheck);
  let appliedFixes: string[] = [];
  let pruneStats: AnnotationPruneStats = { maskPointsPruned: 0, duplicateGcpsPruned: 0 };
  for (const relPath of annotationPathsToCheck) {
    try {
      const raw = JSON.parse(await readFile(`.build-cache/${relPath}`, "utf-8"));
      const sanitized = sanitizeMirroredAnnotation(raw);
      pruneStats.maskPointsPruned += sanitized.stats.maskPointsPruned;
      pruneStats.duplicateGcpsPruned += sanitized.stats.duplicateGcpsPruned;
      if (sanitized.appliedFixes.length > 0) {
        appliedFixes.push(...sanitized.appliedFixes.map((f) => `${relPath}:${f}`));
        // NOTE: Do NOT write pruned version back to cache. Cache must stay RAW from Allmaps.
        // Pruning is re-applied fresh on every build so thresholds can be tuned without re-fetching.
      }
    } catch (err: any) {
      console.warn(`[WARN] Could not sanitize mirrored annotation: .build-cache/${relPath} (${err?.message ?? err})`);
    }
  }
  appliedFixes = uniqueStrings(appliedFixes);
  if (pruneStats.maskPointsPruned > 0 || pruneStats.duplicateGcpsPruned > 0) {
    console.log(
      `    pruned: mask points=${pruneStats.maskPointsPruned}, duplicate GCPs=${pruneStats.duplicateGcpsPruned}`
    );
  }

  const issuesAfterFix = await collectAnnotationIssues(annotationPathsToCheck);
  if (issuesAfterFix.length > 0) {
    const issueCodes = uniqueStrings(issuesAfterFix.map((x) => x.code)) as AnnotationIssue["code"][];
    const issueMessages = summarizeIssues(issuesAfterFix);
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

  const compiledManifestPath = `manifests/${sha1(url).slice(0, 16)}.json`;
  const compiled = compileV2Manifest(man);
  await writeFile(`.build-cache/${compiledManifestPath}`, JSON.stringify(compiled, null, 2), "utf-8");

  const fixedManifest: SuccessfulFixManifest | undefined = issuesBeforeFix.length > 0
    ? {
        manifestAllmapsId,
        label: (man.label ?? label ?? "").toString(),
        sourceManifestUrl: url,
        annotationPaths: annotationPathsToCheck,
        issuesBefore: summarizeIssues(issuesBeforeFix),
        appliedFixes,
        maskPointsPruned: pruneStats.maskPointsPruned,
        duplicateGcpsPruned: pruneStats.duplicateGcpsPruned
      }
    : undefined;

  // Fetch info.json for georeffed canvases, skipping already-cached entries.
  const canvasInfoEntries: Record<string, any> = {};
  const canvasImageServices = extractCanvasImageServices(man);
  for (const canvasId of Object.keys(mirroredCanvasRelByCanvasId)) {
    const serviceUrl = canvasImageServices[canvasId];
    if (!serviceUrl) continue;
    const serviceKey = serviceUrl.replace(/\/+$/, "");
    if (existingCanvasInfoIds.has(serviceKey)) continue;
    try {
      canvasInfoEntries[serviceKey] = await fetchJson(`${serviceKey}/info.json`);
    } catch (err: any) {
      console.warn(`[WARN] Could not fetch info.json for canvas ${canvasId}: ${err?.message ?? err}`);
    }
  }

  const center = await deriveAnnotationCenter(annotationPathsToCheck);

  return {
    kind: "ok",
    entry: {
      label: (man.label ?? label ?? "").toString(),
      sourceManifestUrl: url,
      sourceCollectionUrl,
      sourceCollectionLabel,
      ...(center ? { centerLon: center[0], centerLat: center[1] } : {}),
      compiledManifestPath,
      canvasCount: canvasIds.length,
      isVerzamelblad,
      manifestAllmapsId,
      georefDetectedBy,
      annotSource: canvasIds.length === 1 ? "single" : "multi"
    },
    georef: true,
    compiled: true,
    pruneStats,
    fixed: fixedManifest,
    canvasInfoEntries
  };
}

// ============================================================================
// Phase C: Toponyms and Parcels Generation
// ============================================================================

/**
 * Generate per-map Toponyms files from data/sources/Toponyms/
 */
async function generateToponyms(registry: any): Promise<void> {
  const sourceRoot = "data/sources/Toponyms";
  const outDir = "build/Toponyms";

  // Map source directory names to PascalCase IDs
  const mapIdMapping: Record<string, { id: string; label: string }> = {
    Ferraris: { id: "Ferraris", label: "Ferraris" },
    Primitief: { id: "PrimitiefKadaster", label: "Primitief Kadaster" },
    Gereduceerd: { id: "GereduceerdeKadaster", label: "Gereduceerde Kadaster" },
  };

  try {
    const sourceDirs = await readdir(sourceRoot, { withFileTypes: true });
    const topLevelDirs = sourceDirs
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    if (topLevelDirs.length === 0) {
      console.log(`  Toponyms: no source directories found`);
      return;
    }

    // Group items by map
    const itemsByMap = new Map<string, any[]>();

    for (const dir of topLevelDirs) {
      const dirPath = join(sourceRoot, dir);
      const mapInfo = mapIdMapping[dir];
      if (!mapInfo) {
        console.warn(`  [Toponyms] Warning: Unknown source directory "${dir}"`);
        continue;
      }

      const mapId = mapInfo.id;
      if (!itemsByMap.has(mapId)) {
        itemsByMap.set(mapId, []);
      }

      // Read all GeoJSON files in this directory
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/\.(geojson|json)$/i.test(entry.name)) continue;

        try {
          let content = await readFile(join(dirPath, entry.name), "utf-8");
          // Fix invalid JSON: replace NaN with null
          content = content.replace(/:\s*NaN(?=[,}\]])/g, ": null");
          const geojson = JSON.parse(content);
          const features = Array.isArray(geojson.features) ? geojson.features : [];
          let processedCount = 0;

          for (const feature of features) {
            if (feature.type !== "Feature" || !feature.geometry) continue;
            if (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon") continue;

            let text = String(feature.properties?.text ?? "").trim();
            if (!text) continue;

            // Filter out entries that don't make sense for toponyms
            // - Single letters (likely OCR errors)
            // - Entries that are purely numeric
            // - Entries shorter than 2 characters
            // - Entries that are mostly special characters
            // - Entries with unusual patterns (starting/ending with special chars, too many special chars)
            // - OCR patterns (###, repeated special chars)
            if (text.length < 2) continue;
            if (/^\d+$/.test(text)) continue; // Pure numbers
            if (/^[^a-zA-Z0-9\s]+$/.test(text)) continue; // Only special chars
            if (/^[-_:,;.!?'"]+|[-_:,;.!?'"]+$/.test(text)) continue; // Starts/ends with special chars
            if (/^#+|#+$/.test(text)) continue; // Starts/ends with ###
            if (/#/.test(text)) continue; // Contains # character (OCR artifact)
            if (/(.)\1{3,}/.test(text)) continue; // 4+ repeated characters (OCR artifact)

            // Count special characters - skip if more than 20% are special
            const specialCharCount = (text.match(/[^a-zA-Z0-9\s]/g) || []).length;
            if (specialCharCount > text.length * 0.2) continue;

            // Normalize text: remove extra whitespace
            text = text.replace(/\s+/g, " ").trim();

            processedCount++;

            // Compute centroid from geometry
            const positions = feature.geometry.type === "Polygon"
              ? feature.geometry.coordinates.flat()
              : feature.geometry.coordinates.flat(2);

            if (positions.length === 0) continue;

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const [x, y] of positions) {
              if (Number.isFinite(x) && Number.isFinite(y)) {
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
              }
            }

            if (!Number.isFinite(minX)) continue;

            const [lon, lat] = [(minX + maxX) / 2, (minY + maxY) / 2];
            const idSeed = `${entry.name}:${text}`;
            const id = createHash("sha1").update(idSeed).digest("hex").slice(0, 16);

            const sheet = entry.name.split("_")[1] || undefined;

            itemsByMap.get(mapId)!.push({
              id,
              text,
              lon,
              lat,
              map: mapId,
              ...(sheet ? { sheet } : {}),
            });
          }
        } catch (error: any) {
          console.warn(`  [Toponyms] Warning: Failed to parse ${join(dir, entry.name)}: ${error?.message ?? error}`);
        }
      }
    }

    // Write per-map files
    for (const [mapId, items] of itemsByMap) {
      if (items.length === 0) continue;

      items.sort((a, b) => a.text.localeCompare(b.text));
      const mapInfo = Object.values(mapIdMapping).find((m) => m.id === mapId);
      if (!mapInfo) continue;

      const mapDir = join(outDir, mapId);
      await mkdir(mapDir, { recursive: true });

      const output = {
        generatedAt: new Date().toISOString(),
        map: mapId,
        mapLabel: mapInfo.label,
        itemCount: items.length,
        items,
      };

      const mapIndexPath = join(mapDir, `${mapId}Toponyms.json`);
      await writeFile(mapIndexPath, JSON.stringify(output, null, 2), "utf-8");
    }

    const totalItems = Array.from(itemsByMap.values()).reduce((sum, items) => sum + items.length, 0);
    console.log(`  Toponyms: ${totalItems} items across ${itemsByMap.size} maps`);
  } catch (error: any) {
    console.warn(`  [Toponyms] Error: ${error?.message ?? error}`);
  }
}

/**
 * Generate per-map Parcels files from data/sources/Parcels/
 */
async function generateParcels(): Promise<void> {
  const sourceRoot = "data/sources/Parcels";
  const outDir = "build/Parcels";
  const mapIdMapping: Record<string, string> = {
    Primitive: "PrimitiefKadaster",
    Primitief: "PrimitiefKadaster",
  };

  try {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    const sourceDirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);

    if (sourceDirs.length === 0) {
      console.log(`  Parcels: no source parcel directories found`);
      return;
    }

    let totalPolygons = 0;

    for (const sourceDir of sourceDirs) {
      const mapId = mapIdMapping[sourceDir] || sourceDir;
      const mapSourcePath = join(sourceRoot, sourceDir);

      const consolidatedFeatures: any[] = [];

      try {
        const parcelEntries = await readdir(mapSourcePath, { withFileTypes: true });
        for (const entry of parcelEntries) {
          if (!entry.isFile() || !entry.name.endsWith(".geojson") || entry.name === "index.geojson") continue;

          try {
            const content = await readFile(join(mapSourcePath, entry.name), "utf-8");
            const geojson = JSON.parse(content);

            if (geojson.type === "FeatureCollection" && Array.isArray(geojson.features)) {
              for (const feature of geojson.features) {
                if (feature.type === "Feature" && feature.geometry?.type === "Polygon") {
                  consolidatedFeatures.push({
                    type: "Feature",
                    properties: {},
                    geometry: {
                      type: "Polygon",
                      coordinates: feature.geometry.coordinates,
                    },
                  });
                }
              }
            }
          } catch {
            // Skip invalid files
          }
        }
      } catch (error) {
        console.warn(`  [Parcels] Warning: Failed to read ${mapSourcePath}`);
      }

      if (consolidatedFeatures.length > 0) {
        const mapDir = join(outDir, mapId);
        await mkdir(mapDir, { recursive: true });

        const consolidatedGeoJSON = {
          type: "FeatureCollection",
          features: consolidatedFeatures,
        };

        const indexPath = join(mapDir, `${mapId}Parcels.geojson`);
        await writeFile(indexPath, JSON.stringify(consolidatedGeoJSON), "utf-8");
        totalPolygons += consolidatedFeatures.length;
      }
    }

    console.log(`  Parcels: ${totalPolygons} polygons consolidated`);
  } catch (error: any) {
    console.warn(`  [Parcels] Error: ${error?.message ?? error}`);
  }
}

async function main() {
  await mkdir("cache/collections", { recursive: true });
  await mkdir("cache/manifests", { recursive: true });
  await mkdir("cache/allmaps", { recursive: true });
  await mkdir("logs", { recursive: true });
  const rawAnnotationsByCanvas = await loadRawAnnotationCache();

  // Show which simplification algorithm is configured
  const simplifyConfig = getSimplificationConfig();
  const configStr = simplifyConfig.algorithm === "douglas-peucker"
    ? `Douglas-Peucker (epsilon=${simplifyConfig.epsilon})`
    : `Greedy Batching (diagonalFactor=${simplifyConfig.diagonalFactor}, minDeviation=${simplifyConfig.minDeviation})`;
  console.log(`Using mask simplification: ${configStr}`);

  console.log("[0/5] Cleaning build output directories...");
  // Remove deprecated public-layout directories from earlier refactors.
  for (const dir of ["build/manifests", "build/collections", "build/allmaps", "build/Massart", "build/iiif"]) {
    await rm(dir, { recursive: true, force: true });
  }
  for (const file of ["build/collection.json", "build/fixed-manifests.log", "build/problematic-manifests.log", "build/report.log"]) {
    await rm(file, { force: true });
  }
  // Create public output directories
  await mkdir("build/IIIF", { recursive: true });
  await mkdir("build/Toponyms", { recursive: true });
  await mkdir("build/Parcels", { recursive: true });
  await mkdir("build/Image collections", { recursive: true });
  // Create internal cache directories (hidden)
  await mkdir(".build-cache/manifests", { recursive: true });
  await mkdir(".build-cache/collections", { recursive: true });
  await mkdir(".build-cache/allmaps", { recursive: true });
  await mkdir(".build-cache/iiif/info", { recursive: true });
  await mkdir(".build-cache/allmaps/raw-canvases", { recursive: true });
  await mkdir(".build-cache/allmaps/canvases", { recursive: true });

  // Persistent canvas info.json index — keyed by image service URL.
  // Migrate legacy entries that were keyed by canvas URL (containing /canvas/).
  const canvasInfoIndexPath = ".build-cache/iiif/info/index.json";
  let canvasInfoIndex: Record<string, any> = {};
  try {
    canvasInfoIndex = JSON.parse(await readFile(canvasInfoIndexPath, "utf-8"));
    const legacyKeys = Object.keys(canvasInfoIndex).filter((k) => k.includes("/canvas/"));
    if (legacyKeys.length > 0) {
      for (const k of legacyKeys) delete canvasInfoIndex[k];
      console.log(`  Migrated iiif/info/index.json: removed ${legacyKeys.length} legacy canvas-URL entries`);
    }
  } catch {
    // First run or file missing — start empty.
  }
  const existingCanvasInfoIds = new Set(Object.keys(canvasInfoIndex));

  const registry = await readSourceRegistry();
  const collectionUrls = iiifSourceUrls(registry);
  if (collectionUrls.length < 1) throw new Error("No IIIF sources found in data/sources/registry.json");

  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : undefined;

  console.log(`[1/5] Resolving manifests from ${collectionUrls.length} source(s)...`);
  const sourceGroups: SourceGroup[] = [];
  const ugentMassartItems: UgentMassartItem[] = [];
  for (const collectionUrl of collectionUrls) {
    console.log(`  - ${collectionUrl}`);
    if (collectionUrl === "ugent://massart") {
      const { group, items } = await resolveUgentMassartSource(limit);
      sourceGroups.push(group);
      ugentMassartItems.push(...items);
    } else {
      const group = await resolveSourceGroup(collectionUrl);
      sourceGroups.push(group);
    }
    console.log(`    label: "${sourceGroups.at(-1)!.sourceCollectionLabel}" -> ${sourceGroups.at(-1)!.refs.length} manifest(s)`);
  }

  const totalRefs = sourceGroups.reduce((n, g) => n + g.refs.length, 0);
  console.log(`[2/5] Total manifests: ${totalRefs}${limit ? ` (LIMIT=${limit} applied per source)` : ""}${INCLUDE_NON_GEOREF ? " (INCLUDE_NON_GEOREF=1)" : ""}`);

  console.log(`[3/5] Processing manifests per source...`);
  const index: IndexEntry[] = [];
  const fixedManifests: SuccessfulFixManifest[] = [];
  const problematicManifests: ProblematicManifest[] = [];
  const spriteFailures = new Map<string, SpriteFailure>();
  let georefManifests = 0;
  let compiledOk = 0;
  let newCanvasInfoCount = 0;
  let totalMaskPointsPruned = 0;
  let totalDuplicateGcpsPruned = 0;

  function recordSpriteFailure(failure: SpriteFailure) {
    const key = `${failure.canvasAllmapsId}::${failure.serviceId}`;
    const existing = spriteFailures.get(key);
    if (!existing) {
      spriteFailures.set(key, failure);
      return;
    }
    if (existing.reason.startsWith("Sprite fetch failed:")) {
      return;
    }
    spriteFailures.set(key, failure);
  }

  for (const group of sourceGroups) {
    console.log(`  Source: ${group.sourceCollectionUrl}`);
    const slice = typeof limit === "number" && Number.isFinite(limit) ? group.refs.slice(0, limit) : group.refs;

    for (let i = 0; i < slice.length; i++) {
      const ref = slice[i];
      const checkId = await generateId(ref.url);
      if (PROBLEMATIC_MANIFEST_IDS.has(checkId)) {
        console.warn(`[WARN] Known problematic manifest entering auto-fix path: ${ref.url} (${checkId})`);
      }

      const result = await processManifestRef(ref, group.sourceCollectionUrl, group.sourceCollectionLabel, i, slice.length, existingCanvasInfoIds, rawAnnotationsByCanvas);
      if (result.kind === "problematic") {
        problematicManifests.push(result.problematic);
        continue;
      }
      index.push(result.entry);
      totalMaskPointsPruned += result.pruneStats.maskPointsPruned;
      totalDuplicateGcpsPruned += result.pruneStats.duplicateGcpsPruned;
      if (result.fixed) {
        fixedManifests.push(result.fixed);
      }
      if (result.georef) georefManifests++;
      if (result.compiled) compiledOk++;
      for (const [serviceKey, info] of Object.entries(result.canvasInfoEntries)) {
        canvasInfoIndex[serviceKey] = info;
        existingCanvasInfoIds.add(serviceKey);
        newCanvasInfoCount++;
      }
    }
  }

  console.log(`[4/5] Writing per-source compiled collections and build/index.json`);

  const layerMeta: Array<{
    layerId: string;
    sourceCollectionUrl: string;
    sourceCollectionLabel: string;
    geomapsPath: string;
    manifestCount: number;
    georefCount: number;
    singleCanvasGeorefCount: number;
    multiCanvasGeorefCount: number;
  }> = [];
  const renderLayerMeta: Array<{
    layerId: string;
    sourceCollectionUrl: string;
    sourceCollectionLabel: string;
    renderLayerKey: "default" | "verzamelblad";
    geomapsPath: string;
    manifestCount: number;
    georefCount: number;
    singleCanvasGeorefCount: number;
    multiCanvasGeorefCount: number;
    hidden: false;
  }> = [];

  for (const group of sourceGroups) {
    const entries = index.filter((e) => e.sourceCollectionUrl === group.sourceCollectionUrl);
    const compiledEntries = entries.filter((e) => e.compiledManifestPath);
    const colSlug = sha1(group.sourceCollectionUrl).slice(0, 16);
    const mapId = deriveMapId(group.sourceCollectionUrl, group.sourceCollectionLabel, registry);
    const geomapsPath = mapId ? `IIIF/${mapId}_geomaps.json` : "";

    layerMeta.push({
      layerId: colSlug,
      sourceCollectionUrl: group.sourceCollectionUrl,
      sourceCollectionLabel: group.sourceCollectionLabel,
      geomapsPath,
      manifestCount: compiledEntries.length,
      georefCount: compiledEntries.filter((e) => e.georefDetectedBy).length,
      singleCanvasGeorefCount: compiledEntries.filter((e) => e.annotSource === "single").length,
      multiCanvasGeorefCount: compiledEntries.filter((e) => e.annotSource === "multi").length
    });

    const byRenderLayer: Record<"default" | "verzamelblad", IndexEntry[]> = {
      default: compiledEntries.filter((e) => !e.isVerzamelblad),
      verzamelblad: compiledEntries.filter((e) => e.isVerzamelblad)
    };

    for (const renderLayerKey of ["default", "verzamelblad"] as const) {
      const renderEntries = byRenderLayer[renderLayerKey];
      if (renderEntries.length < 1) continue;
      const renderLayerSlug = sha1(`${group.sourceCollectionUrl}::${renderLayerKey}`).slice(0, 16);
      const renderLayerLabel = renderLayerKey === "verzamelblad"
        ? `${group.sourceCollectionLabel || group.sourceCollectionUrl} - Verzamelblad`
        : group.sourceCollectionLabel || group.sourceCollectionUrl;
      renderLayerMeta.push({
        layerId: renderLayerSlug,
        sourceCollectionUrl: group.sourceCollectionUrl,
        sourceCollectionLabel: group.sourceCollectionLabel,
        renderLayerKey,
        geomapsPath,
        manifestCount: renderEntries.length,
        georefCount: renderEntries.filter((e) => e.georefDetectedBy).length,
        singleCanvasGeorefCount: renderEntries.filter((e) => e.annotSource === "single").length,
        multiCanvasGeorefCount: renderEntries.filter((e) => e.annotSource === "multi").length,
        hidden: false
      });
    }
  }

  // Helper functions for pruning geomaps data

  // Convert new AnnotationPage format back to old GeoreferencedMap format for viewer compatibility
  function normalizeGeoreferencedMapFormat(map: any): any {
    if (!map) return map;

    // Check if this is the new AnnotationPage format
    if (map.type === "AnnotationPage" && Array.isArray(map.items) && map.items.length > 0) {
      const annotation = map.items[0];
      if (!annotation || annotation.type !== "Annotation") return map;

      const source = annotation.target?.source;
      const selector = annotation.target?.selector;
      const body = annotation.body;

      if (!source || !selector) return map;

      // Extract resourceMask from SVG selector if present
      let resourceMask: Array<[number, number]> | undefined;
      if (selector.type === "SvgSelector" && typeof selector.value === "string") {
        const match = selector.value.match(/<polygon[^>]*points="([^"]*)"/);
        if (match && match[1]) {
          resourceMask = parseSvgPolygonPoints(match[1]);
        }
      }

      // Extract GCPs from body if present
      let gcps: any[] | undefined;
      if (body?.type === "FeatureCollection" && Array.isArray(body.features)) {
        gcps = body.features.map((feature: any) => ({
          resource: feature.properties?.resourceCoords,
          geo: feature.geometry?.coordinates
        }));
      }

      // Rebuild in old GeoreferencedMap format
      const oldFormat: any = {
        "@context": "https://schemas.allmaps.org/map/2/context.json",
        type: "GeoreferencedMap",
        id: annotation.id || map.id,
        resource: {
          id: source.id,
          height: source.height,
          width: source.width,
          type: source.type,
          partOf: source.partOf
        }
      };

      // Add GCPs if extracted
      if (gcps && gcps.length > 0) {
        oldFormat.gcps = gcps;
      }

      // Use polynomial transformation for all (more stable than thinPlateSpline)
      oldFormat.transformation = { type: "polynomial", options: { order: 1 } };

      // Add resourceMask if extracted
      if (resourceMask && resourceMask.length > 0) {
        oldFormat.resourceMask = resourceMask;
      }

      return oldFormat;
    }

    // If already in old format, return as-is
    return map;
  }

  // Parse SVG polygon points attribute into coordinate array (used by format converter)
  function parseSvgPolygonPoints(pointsStr: string): Array<[number, number]> {
    const coords: Array<[number, number]> = [];
    const numbers = pointsStr.match(/-?\d+(\.\d+)?/g) || [];
    for (let i = 0; i < numbers.length; i += 2) {
      coords.push([parseFloat(numbers[i]), parseFloat(numbers[i + 1])]);
    }
    return coords;
  }

  function pruneGeoreferencedMap(map: any): { map: any; maskPointsPruned: number } {
    if (!map) return { map, maskPointsPruned: 0 };

    // First, normalize to old GeoreferencedMap format for viewer compatibility
    let normalized = normalizeGeoreferencedMapFormat(map);
    const pruned = JSON.parse(JSON.stringify(normalized));
    delete pruned.created;
    delete pruned.modified;
    let maskPointsPruned = 0;

    // Remove provider from resource if present
    if (pruned.resource && typeof pruned.resource === "object") {
      delete pruned.resource.provider;
    }

    // Optimize resourceMask if present (old format)
    if (Array.isArray(pruned.resourceMask)) {
      const width = Number(pruned.resource?.width);
      const height = Number(pruned.resource?.height);

      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        let coords = pruned.resourceMask;
        const startPointCount = coords.length;

        // Apply same optimizations as sanitizeMirroredAnnotation
        let clampedCount = 0;
        coords = coords.map(([x, y]: [number, number]) => {
          const nx = Math.max(0, Math.min(width, x));
          const ny = Math.max(0, Math.min(height, y));
          if (nx !== x || ny !== y) clampedCount++;
          return [nx, ny] as [number, number];
        });

        let polygonNormalized = normalizePolygon(coords);

        // Gentle simplification
        let simplified = simplifyMask(polygonNormalized, width, height);
        if (simplified.length >= 3 && simplified.length < polygonNormalized.length) {
          polygonNormalized = simplified;
        }

        // Convex hull as last resort for self-intersecting polygons
        if (hasSelfIntersections(polygonNormalized)) {
          const hull = convexHull(polygonNormalized);
          if (hull.length >= 3 && !hasSelfIntersections(hull)) {
            polygonNormalized = hull;
          }
        }

        maskPointsPruned = startPointCount - polygonNormalized.length;
        pruned.resourceMask = polygonNormalized;
      }
    }

    return { map: pruned, maskPointsPruned };
  }

  function pruneInfo(info: any): any {
    if (!info) return info;
    const pruned = { ...info };
    delete (pruned as any).sizes;  // Remove thumbnail pyramid (not used by Allmaps)
    return pruned;
  }

  // Sprite generation helpers
  const ALLMAPS_SPRITE_MAX_SIZE = 128;
  const MASSART_SPRITE_MAX_SIZE = 256;
  const ALLMAPS_SPRITESHEET_MAX_WIDTH = 4096;

  type PackedSpriteSource = {
    canvasItem: any;
    canvasAllmapsId: string;
    imageId: string;
    fullWidth: number;
    fullHeight: number;
    spriteWidth: number;
    spriteHeight: number;
    buffer: Buffer;
  };

  type PackedSpritePlacement = PackedSpriteSource & {
    x: number;
    y: number;
  };

  function calculateSpriteSize(width: number, height: number): { width: number; height: number } {
    // Fit into a fixed 128px bounding box so the generated sprite always stays
    // safely below Allmaps' current single-tile sprite limit.
    const targetLong = ALLMAPS_SPRITE_MAX_SIZE;
    const aspect = width / height;
    return width >= height
      ? { width: targetLong, height: Math.max(1, Math.round(targetLong / aspect)) }
      : { width: Math.max(1, Math.round(targetLong * aspect)), height: targetLong };
  }

  function buildAllmapsSprite(
    imageId: string,
    fullWidth: number,
    fullHeight: number,
    spriteWidth: number,
    spriteHeight: number,
    x = 0,
    y = 0
  ): {
    imageId: string;
    scaleFactor: number;
    spriteTileScale: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const scaleFactor = Math.max(fullWidth / spriteWidth, fullHeight / spriteHeight);
    return {
      imageId,
      scaleFactor,
      spriteTileScale: ALLMAPS_SPRITE_MAX_SIZE / 256,
      x,
      y,
      width: spriteWidth,
      height: spriteHeight
    };
  }

  function packSpritesIntoSheet(sprites: PackedSpriteSource[]): {
    width: number;
    height: number;
    placements: PackedSpritePlacement[];
  } {
    if (sprites.length === 0) {
      return { width: 0, height: 0, placements: [] };
    }

    const totalArea = sprites.reduce((sum, sprite) => sum + (sprite.spriteWidth * sprite.spriteHeight), 0);
    const widestSprite = sprites.reduce((max, sprite) => Math.max(max, sprite.spriteWidth), 0);
    const targetWidth = Math.max(
      widestSprite,
      Math.min(ALLMAPS_SPRITESHEET_MAX_WIDTH, Math.ceil(Math.sqrt(totalArea)))
    );

    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    let sheetWidth = 0;
    const placements: PackedSpritePlacement[] = [];

    for (const sprite of [...sprites].sort((a, b) => b.spriteHeight - a.spriteHeight)) {
      if (cursorX > 0 && cursorX + sprite.spriteWidth > targetWidth) {
        cursorX = 0;
        cursorY += rowHeight;
        rowHeight = 0;
      }

      placements.push({
        ...sprite,
        x: cursorX,
        y: cursorY
      });

      cursorX += sprite.spriteWidth;
      rowHeight = Math.max(rowHeight, sprite.spriteHeight);
      sheetWidth = Math.max(sheetWidth, cursorX);
    }

    return {
      width: sheetWidth,
      height: cursorY + rowHeight,
      placements
    };
  }

  type SpriteAtlasEntry = ReturnType<typeof buildAllmapsSprite>;

  async function fetchSprite(
    serviceUrl: string,
    infoJson: any,
    spriteSize: { width: number; height: number },
    cachePath: string
  ): Promise<Buffer> {
    // Check disk cache first
    try {
      return await readFile(cachePath);
    } catch {}

    const normalizedServiceUrl = serviceUrl.replace(/\/info\.json$/i, "").replace(/\/+$/, "");
    const parsedImage = Image.parse(infoJson);
    const parserRequest = parsedImage.getImageRequest(spriteSize);
    const parserUrl = parsedImage.getImageUrl(parserRequest);
    const localResizeFallbackUrls = [
      `${normalizedServiceUrl}/full/full/0/default.jpg`,
      `${normalizedServiceUrl}/full/max/0/default.jpg`,
      `${normalizedServiceUrl}/full/full/0/native.jpg`,
      `${normalizedServiceUrl}/full/max/0/native.jpg`
    ];
    const candidateUrls = [
      // Prefer explicit width/height because this server often rejects canonical
      // IIIF v2 `w,` URLs with 502s for otherwise valid images.
      `${normalizedServiceUrl}/full/${spriteSize.width},${spriteSize.height}/0/default.jpg`,
      // Some services behave better with the confined-size syntax.
      `${normalizedServiceUrl}/full/!${spriteSize.width},${spriteSize.height}/0/default.jpg`,
      // Keep the parser-generated canonical URL as a final fallback.
      parserUrl
    ];

    const seen = new Set<string>();
    let buffer: Buffer | null = null;
    const errors: string[] = [];
    const retryableStatuses = new Set([429, 500, 502, 503, 504]);

    for (const imageUrl of candidateUrls) {
      if (seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(imageUrl);
          if (!res.ok) {
            if (retryableStatuses.has(res.status) && attempt < 3) {
              await Bun.sleep(250 * attempt);
              continue;
            }
            errors.push(`${res.status} ${imageUrl}`);
            break;
          }
          buffer = Buffer.from(await res.arrayBuffer());
          break;
        } catch (err) {
          if (attempt < 3) {
            await Bun.sleep(250 * attempt);
            continue;
          }
          errors.push(`${err instanceof Error ? err.message : String(err)} ${imageUrl}`);
        }
      }
      if (buffer) {
        break;
      }
    }

    if (!buffer) {
      for (const imageUrl of localResizeFallbackUrls) {
        if (seen.has(imageUrl)) continue;
        seen.add(imageUrl);
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const res = await fetch(imageUrl);
            if (!res.ok) {
              if (retryableStatuses.has(res.status) && attempt < 2) {
                await Bun.sleep(400 * attempt);
                continue;
              }
              errors.push(`${res.status} ${imageUrl}`);
              break;
            }

            const originalBuffer = Buffer.from(await res.arrayBuffer());
            buffer = await sharp(originalBuffer)
              .resize({
                width: spriteSize.width,
                height: spriteSize.height,
                fit: "inside",
                withoutEnlargement: true
              })
              .jpeg({ quality: 80 })
              .toBuffer();
            break;
          } catch (err) {
            if (attempt < 2) {
              await Bun.sleep(400 * attempt);
              continue;
            }
            errors.push(`${err instanceof Error ? err.message : String(err)} ${imageUrl}`);
          }
        }
        if (buffer) {
          break;
        }
      }
    }

    if (!buffer) {
      throw new Error(`Sprite fetch failed: ${errors.join(" | ")}`);
    }

    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, buffer);
    return buffer;
  }

  // [Phase B] Generate per-map IIIF bundles
  console.log(`[4b/5] Generating per-map IIIF bundles...`);
  await mkdir("build/IIIF", { recursive: true });

  let totalSvgMaskPointsPruned = 0;

  // Group entries by map ID
  const manifestsByMapId = new Map<string, typeof index>();

  for (const entry of index) {
    const mapId = deriveMapId(entry.sourceCollectionUrl, entry.sourceCollectionLabel, registry);
    if (!mapId) continue;  // Skip non-IIIF sources

    if (!manifestsByMapId.has(mapId)) {
      manifestsByMapId.set(mapId, []);
    }

    manifestsByMapId.get(mapId)!.push(entry);
  }

  // Generate per-map IIIF files (only for mainLayers, not image collections like Massart)
  for (const [mapId, mapEntries] of manifestsByMapId) {
    // Skip image collections — they only belong under Image collections/, not IIIF/
    const isImageCollection = registry.imageCollections?.some((ic: any) => ic.id === mapId);
    if (isImageCollection) continue;

    // Generate <mapId>_geomaps.json — pre-linked bundle with manifests, canvases, info, and georefs
    const geomaps: any[] = [];
    for (const entry of mapEntries) {
      if (!entry.manifestAllmapsId) continue;  // Only include georeferenced manifests
      if (!entry.compiledManifestPath) continue;

      try {
        const manifestData = JSON.parse(await readFile(`.build-cache/${entry.compiledManifestPath}`, "utf-8"));
        const canvases = manifestData?.sequences?.[0]?.canvases ?? [];

        const canvasItems: any[] = [];
        for (const canvas of canvases) {
          const canvasId = String(canvas?.["@id"] ?? "").trim();
          if (!canvasId) continue;

          // Get georef annotation for this canvas
          const canvasAllmapsId = await generateId(canvasId);
          const annotPath = `.build-cache/allmaps/canvases/${canvasAllmapsId}.json`;
          let georeferencedMap: any = null;
          try {
            const raw = JSON.parse(await readFile(annotPath, "utf-8"));
            const pruneResult = pruneGeoreferencedMap(raw);
            georeferencedMap = pruneResult.map;
            totalSvgMaskPointsPruned += pruneResult.maskPointsPruned;
          } catch {
            // Canvas has no annotation, skip it
            continue;
          }

          // Get info.json for this canvas's image service
          let info: any = null;
          const serviceId = String(canvas.images?.[0]?.resource?.service?.["@id"] ?? "").trim();
          if (serviceId) {
            const normalizedServiceId = serviceId.replace(/\/+$/, "");
            const rawInfo = canvasInfoIndex[normalizedServiceId];
            if (rawInfo) {
              info = pruneInfo(rawInfo);
            }
          }

          const canvasItem: any = {
            id: canvasId,
            canvasAllmapsId,
            info,
            georeferencedMap
          };

          if (info && georeferencedMap && serviceId) {
            const spriteSize = calculateSpriteSize(info.width, info.height);
            const cacheKey = `${canvasAllmapsId}_${spriteSize.width}x${spriteSize.height}.jpg`;
            const cachePath = `.build-cache/sprites/${mapId}/${cacheKey}`;

            try {
              const buffer = await fetchSprite(serviceId, info, spriteSize, cachePath);
              const imageId = georeferencedMap?.resource?.id ?? serviceId;
              if (!imageId) {
                throw new Error("Cannot determine image ID from georeferencedMap.resource.id or serviceId");
              }
              canvasItem._spriteSource = {
                canvasAllmapsId,
                imageId,
                fullWidth: info.width,
                fullHeight: info.height,
                spriteWidth: spriteSize.width,
                spriteHeight: spriteSize.height,
                buffer
              };
            } catch (err) {
              recordSpriteFailure({
                mapId,
                manifestId: String(manifestData["@id"] ?? "").trim(),
                manifestLabel: String(entry.label ?? manifestData.label ?? "").trim(),
                canvasId,
                canvasAllmapsId,
                serviceId,
                reason: err instanceof Error ? err.message : String(err)
              });
              console.warn(`  Sprite failed for ${canvasAllmapsId}: ${err}`);
            }
          }

          canvasItems.push(canvasItem);
        }

        if (canvasItems.length > 0) {
          geomaps.push({
            id: String(manifestData["@id"] ?? "").trim(),
            label: entry.label,
            isVerzamelblad: entry.isVerzamelblad,
            canvases: canvasItems,
          });
        }
      } catch {
        // Skip if manifest processing fails
      }
    }

    if (geomaps.length > 0) {
      const spritesheetImagePath = `IIIF/${mapId}/sprites/sprites.jpg`;
      const spritesheetJsonPath = `IIIF/${mapId}/sprites/sprites.json`;
      const packedSprites: PackedSpriteSource[] = geomaps.flatMap((map) =>
        (Array.isArray(map.canvases) ? map.canvases : []).flatMap((canvas: any) => {
          const spriteSource = canvas?._spriteSource;
          if (!spriteSource?.buffer) return [];
          return [{
            canvasItem: canvas,
            canvasAllmapsId: String(spriteSource.canvasAllmapsId),
            imageId: String(spriteSource.imageId),
            fullWidth: Number(spriteSource.fullWidth),
            fullHeight: Number(spriteSource.fullHeight),
            spriteWidth: Number(spriteSource.spriteWidth),
            spriteHeight: Number(spriteSource.spriteHeight),
            buffer: spriteSource.buffer as Buffer
          }];
        })
      );

      let spritesheetMeta: {
        image: string;
        json: string;
        imageSize: [number, number];
        count: number;
      } | null = null;

      if (packedSprites.length > 0) {
        const { width, height, placements } = packSpritesIntoSheet(packedSprites);
        const spritesDir = `build/IIIF/${mapId}/sprites`;
        await mkdir(spritesDir, { recursive: true });

        const sheet = sharp({
          create: {
            width,
            height,
            channels: 3,
            background: { r: 255, g: 255, b: 255 }
          }
        }).composite(
          placements.map((placement) => ({
            input: placement.buffer,
            left: placement.x,
            top: placement.y
          }))
        );

        await sheet.jpeg({ quality: 65 }).toFile(join(spritesDir, "sprites.jpg"));

        const spritesJson: Record<string, SpriteAtlasEntry> = {};

        for (const placement of placements) {
          const spriteEntry = buildAllmapsSprite(
            placement.imageId,
            placement.fullWidth,
            placement.fullHeight,
            placement.spriteWidth,
            placement.spriteHeight,
            placement.x,
            placement.y
          );
          spritesJson[placement.canvasAllmapsId] = spriteEntry;
        }

        await writeFile(join(spritesDir, "sprites.json"), JSON.stringify(spritesJson, null, 2), "utf-8");
        await writeFile(join(spritesDir, "sprites_debug.json"), JSON.stringify(spritesJson, null, 2), "utf-8");

        for (const placement of placements) {
          placement.canvasItem._spriteRepresented = true;
        }

        spritesheetMeta = {
          image: spritesheetImagePath,
          json: spritesheetJsonPath,
          imageSize: [width, height],
          count: placements.length
        };
      }

      const missingSprites = geomaps.flatMap((map) =>
        (Array.isArray(map.canvases) ? map.canvases : []).flatMap((canvas: any) => {
          const expectsSprite = Boolean(canvas?.georeferencedMap && canvas?.info);
          if (!expectsSprite || canvas?._spriteRepresented) return [];
          return [{
            mapId,
            manifestId: String(map?.id ?? ""),
            manifestLabel: String(map?.label ?? ""),
            canvasId: String(canvas?.id ?? ""),
            canvasAllmapsId: String(canvas?.canvasAllmapsId ?? ""),
            serviceId: String(canvas?.info?.["@id"] ?? canvas?.info?.id ?? ""),
            reason: "Canvas expected a sprite but was not represented in the generated spritesheet"
          } satisfies SpriteFailure];
        })
      );
      if (missingSprites.length > 0) {
        for (const failure of missingSprites) {
          recordSpriteFailure(failure);
        }
      }

      for (const map of geomaps) {
        for (const canvas of Array.isArray(map.canvases) ? map.canvases : []) {
          delete canvas._spriteSource;
          delete canvas._spriteRepresented;
        }
      }

      const geomapsBundle = {
        generatedAt: new Date().toISOString(),
        mapId,
        sprites: spritesheetMeta,
        maps: geomaps
      };
      await writeFile(`build/IIIF/${mapId}_geomaps.json`, JSON.stringify(geomapsBundle, null, 2), "utf-8");
      console.log(`  Generated geomaps bundle for ${mapId}: ${geomaps.length} georeferenced maps, ${geomaps.reduce((sum, m) => sum + m.canvases.length, 0)} canvases`);
    }
  }

  const indexOut = {
    generatedAt: new Date().toISOString(),
    totalManifests: index.length,
    georefManifests,
    compiledOk,
    // Only include mainLayers in domains, not image collections
    domains: Array.from(manifestsByMapId.keys()).filter((mapId) => !registry.imageCollections?.some((ic: any) => ic.id === mapId)),
    layers: layerMeta,
    renderLayers: renderLayerMeta,
    index
  };
  await writeFile("build/index.json", JSON.stringify(indexOut, null, 2), "utf-8");
  await writeFile(canvasInfoIndexPath, JSON.stringify(canvasInfoIndex, null, 2), "utf-8");
  console.log(`  Canvas info.json index: ${Object.keys(canvasInfoIndex).length} entries (${newCanvasInfoCount} new this run)`);
  console.log(`  SVG mask optimization: ${totalSvgMaskPointsPruned} polygon points removed across all georeferences`);
  console.log(`  Annotation pruning: ${totalMaskPointsPruned} resourceMask points removed, ${totalDuplicateGcpsPruned} duplicate GCPs removed`);

  if (ugentMassartItems.length > 0) {
    await mkdir("build/Image collections/Massart", { recursive: true });

    // Fetch sprites for each Massart item
    console.log(`[4c/5] Generating Massart sprites...`);
    type MassartSpriteSource = {
      repId: string;
      fullWidth: number;
      fullHeight: number;
      spriteWidth: number;
      spriteHeight: number;
      buffer: Buffer;
    };

    const massartSpriteSources: MassartSpriteSource[] = [];

    for (const item of ugentMassartItems) {
      // Raw manifests are cached by sha1(url) regardless of georef status
      const rawManifestPath = `.build-cache/manifests/${sha1(item.manifestUrl)}.json`;

      try {
        const manifestData = JSON.parse(await readFile(rawManifestPath, "utf-8"));
        const canvas = manifestData?.sequences?.[0]?.canvases?.[0];
        if (!canvas) continue;

        const serviceId = String(canvas.images?.[0]?.resource?.service?.["@id"] ?? "").trim();
        if (!serviceId) continue;

        const normalizedServiceId = serviceId.replace(/\/+$/, "");
        const info = canvasInfoIndex[normalizedServiceId]
          ?? await cachedJson(`${normalizedServiceId}/info.json`, ".build-cache/iiif").catch(() => null);
        if (!info) continue;

        const spriteSize = calculateSpriteSize(info.width, info.height);
        // Scale up to MASSART_SPRITE_MAX_SIZE (2x IIIF map sprites)
        const scale = MASSART_SPRITE_MAX_SIZE / ALLMAPS_SPRITE_MAX_SIZE;
        const massartSpriteSize = {
          width: Math.round(spriteSize.width * scale),
          height: Math.round(spriteSize.height * scale)
        };
        const cacheKey = `${item.repId}_${massartSpriteSize.width}x${massartSpriteSize.height}.jpg`;
        const cachePath = `.build-cache/sprites/Massart/${cacheKey}`;

        try {
          const buffer = await fetchSprite(serviceId, info, massartSpriteSize, cachePath);
          massartSpriteSources.push({
            repId: item.repId,
            fullWidth: info.width,
            fullHeight: info.height,
            spriteWidth: massartSpriteSize.width,
            spriteHeight: massartSpriteSize.height,
            buffer
          });
        } catch (err) {
          console.warn(`  Massart sprite failed for ${item.repId}: ${err}`);
        }
      } catch {
        // Skip if manifest unreadable
      }
    }

    let massartSpriteMeta: { image: string; json: string; imageSize: [number, number]; count: number } | null = null;

    if (massartSpriteSources.length > 0) {
      const massartDir = "build/Image collections/Massart";

      const packedForSheet: PackedSpriteSource[] = massartSpriteSources.map((s) => ({
        canvasItem: null,
        canvasAllmapsId: s.repId,
        imageId: s.repId,
        fullWidth: s.fullWidth,
        fullHeight: s.fullHeight,
        spriteWidth: s.spriteWidth,
        spriteHeight: s.spriteHeight,
        buffer: s.buffer
      }));

      const { width, height, placements } = packSpritesIntoSheet(packedForSheet);

      const sheet = sharp({
        create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } }
      }).composite(
        placements.map((p) => ({ input: p.buffer, left: p.x, top: p.y }))
      );

      await sheet.jpeg({ quality: 65 }).toFile(join(massartDir, "Massart_sprites.jpg"));
      await sharp(join(massartDir, "Massart_sprites.jpg"))
        .modulate({ hue: 330, saturation: 3.5, brightness: 0.85 })
        .toFile(join(massartDir, "Massart_sprites_debug.jpg"));

      const spritesJson: Record<string, { x: number; y: number; width: number; height: number }> = {};
      for (const p of placements) {
        spritesJson[p.canvasAllmapsId] = { x: p.x, y: p.y, width: p.spriteWidth, height: p.spriteHeight };
      }
      await writeFile(join(massartDir, "Massart_sprites.json"), JSON.stringify(spritesJson, null, 2), "utf-8");

      massartSpriteMeta = {
        image: "Image collections/Massart/Massart_sprites.jpg",
        json: "Image collections/Massart/Massart_sprites.json",
        imageSize: [width, height],
        count: placements.length
      };
      console.log(`  Massart sprites: ${placements.length} sprites packed (${width}×${height}px)`);
    }

    await writeFile("build/Image collections/Massart/Massart_index.json", JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalItems: ugentMassartItems.length,
      coordsAvailable: ugentMassartItems.filter((i) => i.lat !== undefined).length,
      sprites: massartSpriteMeta,
      items: ugentMassartItems,
    }, null, 2), "utf-8");
    console.log(`  Massart index: ${ugentMassartItems.length} items → build/Image collections/Massart/Massart_index.json`);
  }

  // QA report written to logs/ (git-ignored), not build/.
  const problematicLog = problematicManifests.map((m) =>
    [`[SKIP] ${m.manifestAllmapsId}  ${m.label}`, `       ${m.sourceManifestUrl}`,
      `       reason: ${m.reason}`, `       issueTypes: ${m.issueTypes.join(", ") || "-"}`,
      `       annotationPaths: ${m.annotationPaths.join(", ") || "-"}`,
      `       potentialSolutions: ${m.potentialSolutions.join(" | ") || "-"}`].join("\n")
  ).join("\n");
  const fixedLog = fixedManifests.map((m) =>
    [`[FIXED] ${m.manifestAllmapsId}  ${m.label}`, `       ${m.sourceManifestUrl}`,
      `       issuesBefore: ${m.issuesBefore.join(" | ") || "-"}`,
      `       annotationPaths: ${m.annotationPaths.join(", ") || "-"}`,
      `       appliedFixes: ${m.appliedFixes.join(" | ") || "-"}`,
      `       pruned: mask points=${m.maskPointsPruned}, duplicate GCPs=${m.duplicateGcpsPruned}`].join("\n")
  ).join("\n");
  const spriteFailureList = [...spriteFailures.values()];
  const spriteFailureLog = spriteFailureList.map((failure) =>
    [`[SPRITE-MISSING] ${failure.canvasAllmapsId}  ${failure.manifestLabel || failure.manifestId}`,
      `       manifest: ${failure.manifestId || "-"}`,
      `       canvas: ${failure.canvasId || "-"}`,
      `       service: ${failure.serviceId || "-"}`,
      `       reason: ${failure.reason}`].join("\n")
  ).join("\n");
  await writeFile(
    "logs/report.log",
    [`Annotation QA report — generated ${new Date().toISOString()}`, "",
      `Pruned totals: mask points=${totalMaskPointsPruned}, duplicate GCPs=${totalDuplicateGcpsPruned}`, "",
      `Fixed manifests: ${fixedManifests.length}`, fixedManifests.length > 0 ? `\n${fixedLog}` : "  (none)", "",
      `Excluded manifests: ${problematicManifests.length}`, problematicManifests.length > 0 ? `\n${problematicLog}` : "  (none)", "",
      `Sprite failures: ${spriteFailureList.length}`, spriteFailureList.length > 0 ? `\n${spriteFailureLog}` : "  (none)", ""].join("\n"),
    "utf-8"
  );

  if (spriteFailureList.length > 0) {
    console.warn(`[WARN] ${spriteFailureList.length} canvas sprite(s) were missing from generated spritesheets. See logs/report.log`);
  }

  // Generate debug spritesheets with pink tint
  console.log(`[4b+/5] Generating debug spritesheets...`);
  const spriteFiles = Array.from(new Bun.Glob("build/IIIF/*/sprites/sprites.jpg").scanSync());
  for (const spritePath of spriteFiles) {
    const debugPath = spritePath.replace("sprites.jpg", "sprites_debug.jpg");
    await sharp(spritePath)
      .modulate({
        hue: 330,
        saturation: 1.3
      })
      .toFile(debugPath);
  }
  console.log(`  Generated ${spriteFiles.length} debug spritesheet(s)`);

  // [Phase C] Generate Toponyms and Parcels
  console.log(`[4c/5] Generating Toponyms and Parcels...`);
  await generateToponyms(registry);
  await generateParcels();

  console.log(`[5/5] Done.`);
  console.log(`Done. sources=${sourceGroups.length}, manifests=${index.length}, georef=${georefManifests}, compiled=${compiledOk}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
