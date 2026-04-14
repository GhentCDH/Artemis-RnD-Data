import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { generateId } from "@allmaps/id";

// FLAG: set INCLUDE_NON_GEOREF=1 to also compile and include non-georeferenced manifests.
// By default only georeferenced manifests are compiled and listed in collections.
const INCLUDE_NON_GEOREF = !!process.env.INCLUDE_NON_GEOREF;

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
      return { title: rawTitle, year, location, lat: coords?.lat, lon: coords?.lon, manifestUrl, mmsId: recordId, repId };
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

type CanvasAnnotationHit = {
  canvasId: string;
  canvasAllmapsId: string;
  mirroredAllmapsAnnotationPath: string; // always allmaps/canvases/<id>.json
};

type IndexEntry = {
  label: string;
  sourceManifestUrl: string;
  sourceCollectionUrl: string;
  canvasCount: number;
  isVerzamelblad: boolean;
  compiledManifestPath: string; // "" when non-georef and INCLUDE_NON_GEOREF=false
  // Present only for georef manifests:
  centerLon?: number;
  centerLat?: number;
  manifestAllmapsId?: string;
  canvasAllmapsHits?: CanvasAnnotationHit[];
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
      const raw = JSON.parse(await readFile(`build/${relPath}`, "utf-8"));
      merged.push(...extractGeoPointsFromMirroredAnnotation(raw));
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
  const items = Array.isArray(raw?.items) ? raw.items : [];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const width = Number(item?.target?.source?.width);
    const height = Number(item?.target?.source?.height);
    const selector = item?.target?.selector?.value;
    if (typeof selector === "string" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const points = parseSvgPolygonPoints(selector);
      if (hasSelfIntersections(points)) {
        issues.push({ code: "self-intersecting-mask", message: `item[${idx}] mask polygon is self-intersecting`, annotationPath });
      }
      const oobCount = points.filter(([x, y]) => x < 0 || y < 0 || x > width || y > height).length;
      if (oobCount > 0) {
        issues.push({ code: "mask-out-of-bounds", message: `item[${idx}] has ${oobCount} resource mask points outside image bounds`, annotationPath });
      }
    }
    const body = item?.body;
    const features = Array.isArray(body?.features) ? body.features : [];
    const pointFeatures = features.filter((f: any) => f?.geometry?.type === "Point");
    const gcpCount = pointFeatures.length;
    if (body?.transformation?.type === "thinPlateSpline" && gcpCount < 5) {
      issues.push({ code: "tps-low-gcp", message: `item[${idx}] uses thinPlateSpline with only ${gcpCount} GCPs`, annotationPath });
    }
    const geoKeys = pointFeatures
      .map((f: any) => f?.geometry?.coordinates)
      .filter((c: any) => Array.isArray(c) && c.length >= 2)
      .map((c: any) => `${Number(c[0]).toFixed(12)},${Number(c[1]).toFixed(12)}`);
    const dupGeo = geoKeys.length - new Set(geoKeys).size;
    if (dupGeo > 0) {
      issues.push({ code: "duplicate-geo-gcp", message: `item[${idx}] has ${dupGeo} duplicate geographic GCP(s)`, annotationPath });
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
        let clampedCount = 0;
        const clamped = points.map(([x, y]) => {
          const nx = Math.max(0, Math.min(width, x));
          const ny = Math.max(0, Math.min(height, y));
          if (nx !== x || ny !== y) clampedCount++;
          return [nx, ny] as [number, number];
        });
        if (clampedCount > 0) {
          selector.value = selector.value.replace(/points="([^"]+)"/, `points="${serializeSvgPolygonPoints(clamped)}"`);
          appliedFixes.push(`clamped-mask-points:item[${idx}]:${clampedCount}`);
        }
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
        if (f?.geometry?.type !== "Point") { deduped.push(f); continue; }
        const c = f?.geometry?.coordinates;
        if (!Array.isArray(c) || c.length < 2) { deduped.push(f); continue; }
        const key = `${Number(c[0]).toFixed(12)},${Number(c[1]).toFixed(12)}`;
        if (seenGeo.has(key)) { removed++; continue; }
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
    try {
      const raw = JSON.parse(await readFile(`build/${relPath}`, "utf-8"));
      annotationIssues.push(...analyzeMirroredAnnotation(raw, relPath));
    } catch (err: any) {
      console.warn(`[WARN] Could not parse mirrored annotation for QA: build/${relPath} (${err?.message ?? err})`);
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

/**
 * Mirror a canvas-level Allmaps annotation to build/allmaps/canvases/<id>.json.
 * Combines the status check and fetch into one request (no separate HEAD/GET).
 */
async function mirrorCanvasAnnotation(canvasAllmapsId: string): Promise<{ status: number; relPath: string }> {
  const outAbs = `build/allmaps/canvases/${canvasAllmapsId}.json`;
  const outRel = `allmaps/canvases/${canvasAllmapsId}.json`;
  if (await exists(outAbs)) return { status: 200, relPath: outRel };

  const res = await fetch(`https://annotations.allmaps.org/canvases/${canvasAllmapsId}`, { redirect: "follow" });
  if (res.status !== 200) return { status: res.status, relPath: "" };

  const json = await res.json();
  await writeFile(outAbs, JSON.stringify(json, null, 2), "utf-8");
  return { status: 200, relPath: outRel };
}

/**
 * For canvases that have no standalone canvas annotation in Allmaps (canvas endpoint → 404),
 * fetch the manifest-level annotation once and extract each canvas's items into a synthetic
 * canvas file. This eliminates the need for a separate allmaps/manifests/ directory.
 *
 * Returns a map of canvasId → relPath for all canvases that were successfully covered.
 */
async function fillUncoveredCanvasAnnotations(
  manifestAllmapsId: string,
  uncovered: Array<{ canvasId: string; canvasAllmapsId: string; imageServiceUrl: string }>
): Promise<Record<string, string>> {
  if (uncovered.length === 0) return {};

  const result: Record<string, string> = {};
  const needExtract: typeof uncovered = [];

  for (const c of uncovered) {
    const outAbs = `build/allmaps/canvases/${c.canvasAllmapsId}.json`;
    if (await exists(outAbs)) {
      result[c.canvasId] = `allmaps/canvases/${c.canvasAllmapsId}.json`;
    } else {
      needExtract.push(c);
    }
  }

  if (needExtract.length === 0) return result;

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
    await writeFile(`build/allmaps/canvases/${canvasAllmapsId}.json`, JSON.stringify(synthetic, null, 2), "utf-8");
    result[canvasId] = `allmaps/canvases/${canvasAllmapsId}.json`;
  }

  return result;
}

/**
 * Attach canvas-level otherContent references to each canvas that has a mirrored annotation.
 * Canvases without an annotation path are left untouched.
 */
function compileV2ManifestAttachOtherContent(
  source: V2Manifest,
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
    const relPath = mirroredCanvasAnnotationRelPaths[canvasId];
    if (!relPath) continue;

    const entry = {
      "@id": absOrRel(relPath),
      "@type": "sc:AnnotationList",
      "label": "Georeferencing (Allmaps, mirrored by Artemis)"
    };
    const oc = canvas.otherContent;
    if (Array.isArray(oc)) {
      if (!oc.some((x: any) => x?.["@id"] === entry["@id"])) oc.push(entry);
    } else if (oc) {
      const arr = [oc];
      if (!arr.some((x: any) => x?.["@id"] === entry["@id"])) arr.push(entry);
      canvas.otherContent = arr;
    } else {
      canvas.otherContent = [entry];
    }
  }

  out.metadata = Array.isArray(out.metadata) ? out.metadata : [];
  out.metadata.push({ label: "Artemis pipeline", value: "Compiled manifest with mirrored Allmaps georeferencing" });
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

async function resolveSourceGroup(collectionUrl: string): Promise<SourceGroup> {
  const json = (await cachedJson(collectionUrl, "cache/collections")) as V2Collection;
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
  buildBaseUrl: string | null,
  i: number,
  total: number,
  existingCanvasInfoIds: Set<string>
): Promise<
  | { kind: "ok"; entry: IndexEntry; georef: boolean; compiled: boolean; fixed?: SuccessfulFixManifest; canvasInfoEntries: Record<string, any> }
  | { kind: "problematic"; problematic: ProblematicManifest }
> {
  console.log(`  - [${i + 1}/${total}] ${label || "(no label)"} :: ${url}`);

  const man = (await cachedJson(url, "cache/manifests")) as V2Manifest;
  const canvasIds = extractCanvasIdsFromV2Manifest(man);
  const isVerzamelblad = hasVerzamelbladIdentifier(man, url, label);
  const manifestAllmapsId = await generateId(url);

  // Mirror canvas-level annotations. One fetch per canvas (combines status check + download).
  const mirroredCanvasRelByCanvasId: Record<string, string> = {};
  const canvasAllmapsIdByCanvasId: Record<string, string> = {};
  let directCanvasHits = 0;

  for (const canvasId of canvasIds) {
    const canvasAllmapsId = await generateId(canvasId);
    canvasAllmapsIdByCanvasId[canvasId] = canvasAllmapsId;
    const mirror = await mirrorCanvasAnnotation(canvasAllmapsId);
    if (mirror.status === 200 && mirror.relPath) {
      mirroredCanvasRelByCanvasId[canvasId] = mirror.relPath;
      directCanvasHits++;
    }
  }

  // For canvases with no standalone canvas annotation, try extracting from the manifest
  // annotation (fetched once). Saves a separate allmaps/manifests/ directory entirely.
  const uncoveredCanvasIds = canvasIds.filter((id) => !mirroredCanvasRelByCanvasId[id]);
  let manifestExtractedHits = 0;
  if (uncoveredCanvasIds.length > 0) {
    const canvasImageServices = extractCanvasImageServices(man);
    const uncovered = uncoveredCanvasIds
      .map((canvasId) => ({
        canvasId,
        canvasAllmapsId: canvasAllmapsIdByCanvasId[canvasId],
        imageServiceUrl: canvasImageServices[canvasId] ?? ""
      }))
      .filter((c) => c.imageServiceUrl && c.canvasAllmapsId);

    const extracted = await fillUncoveredCanvasAnnotations(manifestAllmapsId, uncovered);
    for (const [canvasId, relPath] of Object.entries(extracted)) {
      mirroredCanvasRelByCanvasId[canvasId] = relPath;
      manifestExtractedHits++;
    }
  }

  const georefDetected = Object.keys(mirroredCanvasRelByCanvasId).length > 0;
  const georefDetectedBy: IndexEntry["georefDetectedBy"] = !georefDetected
    ? undefined
    : directCanvasHits > 0 && manifestExtractedHits > 0
      ? "both"
      : directCanvasHits > 0
        ? "canvas"
        : "manifest";

  // Non-georef manifest: slim index entry, skip compiled manifest (unless flag is set).
  if (!georefDetected) {
    const compiledManifestPath = INCLUDE_NON_GEOREF ? `manifests/${sha1(url).slice(0, 16)}.json` : "";
    if (INCLUDE_NON_GEOREF) {
      await writeFile(`build/${compiledManifestPath}`, JSON.stringify(man, null, 2), "utf-8");
    }
    return {
      kind: "ok",
      entry: { label: (man.label ?? label ?? "").toString(), sourceManifestUrl: url, sourceCollectionUrl, canvasCount: canvasIds.length, isVerzamelblad, compiledManifestPath },
      georef: false,
      compiled: INCLUDE_NON_GEOREF,
      canvasInfoEntries: {}
    };
  }

  // Georef path: QA, sanitize, compile.
  const annotationPathsToCheck = uniqueStrings(Object.values(mirroredCanvasRelByCanvasId));
  const issuesBeforeFix = await collectAnnotationIssues(annotationPathsToCheck);
  let appliedFixes: string[] = [];
  if (issuesBeforeFix.length > 0) {
    for (const relPath of annotationPathsToCheck) {
      try {
        const raw = JSON.parse(await readFile(`build/${relPath}`, "utf-8"));
        const sanitized = sanitizeMirroredAnnotation(raw);
        if (sanitized.appliedFixes.length > 0) {
          appliedFixes.push(...sanitized.appliedFixes.map((f) => `${relPath}:${f}`));
          await writeFile(`build/${relPath}`, JSON.stringify(sanitized.json, null, 2), "utf-8");
        }
      } catch (err: any) {
        console.warn(`[WARN] Could not sanitize mirrored annotation: build/${relPath} (${err?.message ?? err})`);
      }
    }
    appliedFixes = uniqueStrings(appliedFixes);
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
  const compiled = compileV2ManifestAttachOtherContent(man, mirroredCanvasRelByCanvasId, buildBaseUrl);
  await writeFile(`build/${compiledManifestPath}`, JSON.stringify(compiled, null, 2), "utf-8");

  const fixedManifest: SuccessfulFixManifest | undefined = issuesBeforeFix.length > 0
    ? { manifestAllmapsId, label: (man.label ?? label ?? "").toString(), sourceManifestUrl: url, annotationPaths: annotationPathsToCheck, issuesBefore: summarizeIssues(issuesBeforeFix), appliedFixes }
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
  const canvasAllmapsHits: CanvasAnnotationHit[] = Object.entries(mirroredCanvasRelByCanvasId).map(([canvasId, relPath]) => ({
    canvasId,
    canvasAllmapsId: canvasAllmapsIdByCanvasId[canvasId],
    mirroredAllmapsAnnotationPath: relPath
  }));

  return {
    kind: "ok",
    entry: {
      label: (man.label ?? label ?? "").toString(),
      sourceManifestUrl: url,
      sourceCollectionUrl,
      ...(center ? { centerLon: center[0], centerLat: center[1] } : {}),
      compiledManifestPath,
      canvasCount: canvasIds.length,
      isVerzamelblad,
      manifestAllmapsId,
      canvasAllmapsHits,
      georefDetectedBy,
      annotSource: canvasIds.length === 1 ? "single" : "multi"
    },
    georef: true,
    compiled: true,
    fixed: fixedManifest,
    canvasInfoEntries
  };
}

async function main() {
  await mkdir("cache/collections", { recursive: true });
  await mkdir("cache/manifests", { recursive: true });
  await mkdir("logs", { recursive: true });

  console.log("[0/5] Cleaning build output directories...");
  for (const dir of ["build/manifests", "build/collections", "build/allmaps/canvases", "build/Massart"]) {
    await rm(dir, { recursive: true, force: true });
  }
  // Remove legacy allmaps/manifests/ directory — annotations are now canvas-level only.
  await rm("build/allmaps/manifests", { recursive: true, force: true });
  await rm("build/allmaps", { recursive: true, force: true });
  for (const file of ["build/fixed-manifests.log", "build/problematic-manifests.log", "build/report.log"]) {
    await rm(file, { force: true });
  }
  await mkdir("build/manifests", { recursive: true });
  await mkdir("build/collections", { recursive: true });
  await mkdir("build/allmaps/canvases", { recursive: true });
  await mkdir("build/iiif/info", { recursive: true });

  // Persistent canvas info.json index — keyed by image service URL.
  // Migrate legacy entries that were keyed by canvas URL (containing /canvas/).
  const canvasInfoIndexPath = "build/iiif/info/index.json";
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

  const sourcesTxt = await readFile("data/sources/collections.txt", "utf-8");
  const collectionUrls = parseLines(sourcesTxt);
  if (collectionUrls.length < 1) throw new Error("No collection URLs found in data/sources/collections.txt");

  const buildBaseUrl = process.env.BUILD_BASE_URL ?? null;
  const base = (path: string) => buildBaseUrl ? `${buildBaseUrl.replace(/\/+$/, "")}/${path}` : path;
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
  let georefManifests = 0;
  let compiledOk = 0;
  let newCanvasInfoCount = 0;

  for (const group of sourceGroups) {
    console.log(`  Source: ${group.sourceCollectionUrl}`);
    const slice = typeof limit === "number" && Number.isFinite(limit) ? group.refs.slice(0, limit) : group.refs;

    for (let i = 0; i < slice.length; i++) {
      const ref = slice[i];
      const checkId = await generateId(ref.url);
      if (PROBLEMATIC_MANIFEST_IDS.has(checkId)) {
        console.warn(`[WARN] Known problematic manifest entering auto-fix path: ${ref.url} (${checkId})`);
      }

      const result = await processManifestRef(ref, group.sourceCollectionUrl, buildBaseUrl, i, slice.length, existingCanvasInfoIds);
      if (result.kind === "problematic") {
        problematicManifests.push(result.problematic);
        continue;
      }
      index.push(result.entry);
      if (result.fixed) fixedManifests.push(result.fixed);
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
    compiledCollectionPath: string;
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
    compiledCollectionPath: string;
    manifestCount: number;
    georefCount: number;
    singleCanvasGeorefCount: number;
    multiCanvasGeorefCount: number;
    hidden: false;
  }> = [];

  for (const group of sourceGroups) {
    const entries = index.filter((e) => e.sourceCollectionUrl === group.sourceCollectionUrl);
    // Collections only include entries that have a compiled manifest path.
    const compiledEntries = entries.filter((e) => e.compiledManifestPath);

    const colSlug = sha1(group.sourceCollectionUrl).slice(0, 16);
    const colRelPath = `collections/${colSlug}.json`;
    const col: V2Collection = {
      "@context": "http://iiif.io/api/presentation/2/context.json",
      "@id": base(colRelPath),
      "@type": "sc:Collection",
      label: group.sourceCollectionLabel || group.sourceCollectionUrl,
      manifests: compiledEntries.map((e) => ({ "@id": base(e.compiledManifestPath), "@type": "sc:Manifest", label: e.label }))
    };
    await writeFile(`build/${colRelPath}`, JSON.stringify(col, null, 2), "utf-8");

    layerMeta.push({
      layerId: colSlug,
      sourceCollectionUrl: group.sourceCollectionUrl,
      sourceCollectionLabel: group.sourceCollectionLabel,
      compiledCollectionPath: colRelPath,
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
      const renderLayerRelPath = `collections/${renderLayerSlug}.json`;
      const renderLayerLabel = renderLayerKey === "verzamelblad"
        ? `${group.sourceCollectionLabel || group.sourceCollectionUrl} - Verzamelblad`
        : group.sourceCollectionLabel || group.sourceCollectionUrl;
      const renderLayerCol: V2Collection = {
        "@context": "http://iiif.io/api/presentation/2/context.json",
        "@id": base(renderLayerRelPath),
        "@type": "sc:Collection",
        label: renderLayerLabel,
        manifests: renderEntries.map((e) => ({ "@id": base(e.compiledManifestPath), "@type": "sc:Manifest", label: e.label }))
      };
      await writeFile(`build/${renderLayerRelPath}`, JSON.stringify(renderLayerCol, null, 2), "utf-8");
      renderLayerMeta.push({
        layerId: renderLayerSlug,
        sourceCollectionUrl: group.sourceCollectionUrl,
        sourceCollectionLabel: group.sourceCollectionLabel,
        renderLayerKey,
        compiledCollectionPath: renderLayerRelPath,
        manifestCount: renderEntries.length,
        georefCount: renderEntries.filter((e) => e.georefDetectedBy).length,
        singleCanvasGeorefCount: renderEntries.filter((e) => e.annotSource === "single").length,
        multiCanvasGeorefCount: renderEntries.filter((e) => e.annotSource === "multi").length,
        hidden: false
      });
    }
  }

  const indexOut = {
    generatedAt: new Date().toISOString(),
    totalManifests: index.length,
    georefManifests,
    compiledOk,
    layers: layerMeta,
    renderLayers: renderLayerMeta,
    index
  };
  await writeFile("build/index.json", JSON.stringify(indexOut, null, 2), "utf-8");
  await writeFile(canvasInfoIndexPath, JSON.stringify(canvasInfoIndex, null, 2), "utf-8");
  console.log(`  Canvas info.json index: ${Object.keys(canvasInfoIndex).length} entries (${newCanvasInfoCount} new this run)`);

  if (ugentMassartItems.length > 0) {
    await mkdir("build/Massart", { recursive: true });
    await writeFile("build/Massart/index.json", JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalItems: ugentMassartItems.length,
      coordsAvailable: ugentMassartItems.filter((i) => i.lat !== undefined).length,
      items: ugentMassartItems,
    }, null, 2), "utf-8");
    console.log(`  Massart index: ${ugentMassartItems.length} items → build/Massart/index.json`);
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
      `       appliedFixes: ${m.appliedFixes.join(" | ") || "-"}`].join("\n")
  ).join("\n");
  await writeFile(
    "logs/report.log",
    [`Annotation QA report — generated ${new Date().toISOString()}`, "",
      `Fixed manifests: ${fixedManifests.length}`, fixedManifests.length > 0 ? `\n${fixedLog}` : "  (none)", "",
      `Excluded manifests: ${problematicManifests.length}`, problematicManifests.length > 0 ? `\n${problematicLog}` : "  (none)", ""].join("\n"),
    "utf-8"
  );

  console.log(`[5/5] Writing build/collection.json (top-level IIIF collection)`);
  const topCollection = {
    "@context": "http://iiif.io/api/presentation/2/context.json",
    "@id": base("collection.json"),
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

  console.log(`Done. sources=${sourceGroups.length}, manifests=${index.length}, georef=${georefManifests}, compiled=${compiledOk}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
