import { Analyzer, type AnalysisItem } from "@allmaps/analyze";
import type { BuildLog } from "../build/buildLog";
import { simplifyRing } from "../geojson/simplify";
import type { Position } from "../geojson/types";
import { maskSimplifyEpsilon } from "./config";
import { resourceId } from "./iiif";
import type { AnalysisSummary, MapAnalysis } from "./types";

const FIXABLE_ANALYSIS_CODES = new Set([
  "gcpresourcerepeatedpoint",
  "gcpgeorepeatedpoint",
  "maskrepeatedpoint",
  "maskselfintersection",
  "maskpointoutsidefullmask",
]);

const IGNORED_ANALYSIS_WARNING_CODES = new Set([
  // Non-actionable for this dataset: resource masks are used as cutlines, so a
  // GCP outside that mask can still be valid and should not pollute build logs.
  "gcpoutsidemask",
]);

export function parseSvgPolygonPoints(svg: string): Array<[number, number]> {
  const match = svg.match(/<polygon[^>]*points="([^"]*)"/);
  if (!match) return [];
  const numbers = match[1].match(/-?\d+(?:\.\d+)?/g) ?? [];
  const points: Array<[number, number]> = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([Number(numbers[i]), Number(numbers[i + 1])]);
  return points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

function pointKey(point: Position, precision = 6): string {
  return `${point[0].toFixed(precision)},${point[1].toFixed(precision)}`;
}

function normalizeMask(points: Position[]): Position[] {
  const out: Position[] = [];
  for (const point of points) {
    if (!out.length || pointKey(out[out.length - 1]!) !== pointKey(point)) out.push(point);
  }
  if (out.length > 2 && pointKey(out[0]!) === pointKey(out[out.length - 1]!)) out.pop();
  return out;
}

function cross(o: Position, a: Position, b: Position): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function orientation(a: Position, b: Position, c: Position): number {
  const value = cross(a, b, c);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(a: Position, b: Position, point: Position): boolean {
  const eps = 1e-9;
  return (
    Math.min(a[0], b[0]) - eps <= point[0] &&
    point[0] <= Math.max(a[0], b[0]) + eps &&
    Math.min(a[1], b[1]) - eps <= point[1] &&
    point[1] <= Math.max(a[1], b[1]) + eps
  );
}

function segmentsIntersect(a1: Position, a2: Position, b1: Position, b2: Position): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, a2, b1)) return true;
  if (o2 === 0 && onSegment(a1, a2, b2)) return true;
  if (o3 === 0 && onSegment(b1, b2, a1)) return true;
  return o4 === 0 && onSegment(b1, b2, a2);
}

function hasSelfIntersections(pointsInput: Position[]): boolean {
  const points = normalizeMask(pointsInput);
  if (points.length < 4) return false;
  for (let i = 0; i < points.length; i++) {
    const a1 = points[i]!;
    const a2 = points[(i + 1) % points.length]!;
    for (let j = i + 1; j < points.length; j++) {
      const adjacent = i === j || (i + 1) % points.length === j || i === (j + 1) % points.length;
      if (!adjacent && segmentsIntersect(a1, a2, points[j]!, points[(j + 1) % points.length]!)) return true;
    }
  }
  return false;
}

function convexHull(pointsInput: Position[]): Position[] {
  const points = [...new Map(pointsInput.map((point) => [pointKey(point), point])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (points.length <= 2) return points;
  const lower: Position[] = [];
  for (const point of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Position[] = [];
  for (const point of [...points].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

export function normalizeAnnotationPage(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.type !== "AnnotationPage") return raw;
  const annotation = (Array.isArray(raw.items) ? raw.items[0] : null) as Record<string, unknown> | null;
  const target = annotation?.target as Record<string, unknown> | undefined;
  const source = target?.source as Record<string, unknown> | undefined;
  const selector = target?.selector as Record<string, unknown> | undefined;
  const body = annotation?.body as Record<string, unknown> | undefined;
  if (!annotation || !source || !selector || !body) return null;

  const features = Array.isArray(body.features) ? body.features as Array<Record<string, unknown>> : [];
  const gcps = features.flatMap((feature) => {
    const props = feature.properties as Record<string, unknown> | undefined;
    const geometry = feature.geometry as Record<string, unknown> | undefined;
    const resource = props?.resourceCoords;
    const geo = geometry?.coordinates;
    return Array.isArray(resource) && Array.isArray(geo) ? [{ resource, geo }] : [];
  });

  const georeferencedMap: Record<string, unknown> = {
    "@context": "https://schemas.allmaps.org/map/2/context.json",
    type: "GeoreferencedMap",
    id: String(annotation.id ?? raw.id ?? ""),
    resource: {
      id: resourceId(source),
      height: source.height,
      width: source.width,
      type: source.type,
      partOf: source.partOf,
    },
    transformation: { type: "polynomial", options: { order: 1 } },
  };
  if (gcps.length > 0) georeferencedMap.gcps = gcps;
  const selectorValue = typeof selector.value === "string" ? selector.value : "";
  const mask = parseSvgPolygonPoints(selectorValue);
  if (mask.length > 0) georeferencedMap.resourceMask = mask;
  return georeferencedMap;
}

function analyzeMap(georeferencedMap: Record<string, unknown>): AnalysisSummary {
  const analysis = new Analyzer(georeferencedMap as never).analyze();
  const warnings = analysis.warnings.filter((item) => !IGNORED_ANALYSIS_WARNING_CODES.has(item.code.toLowerCase()));
  return { info: analysis.info, warnings, errors: analysis.errors };
}

function hasFixableIssue(summary: AnalysisSummary): boolean {
  return [...summary.errors, ...summary.warnings].some((item) => FIXABLE_ANALYSIS_CODES.has(item.code));
}

function sanitizeForAnalysis(georeferencedMap: Record<string, unknown>): { map: Record<string, unknown>; fixes: string[] } {
  const out = JSON.parse(JSON.stringify(georeferencedMap)) as Record<string, unknown>;
  const fixes: string[] = [];
  const resource = out.resource as Record<string, unknown> | undefined;
  const width = Number(resource?.width);
  const height = Number(resource?.height);

  if (Array.isArray(out.resourceMask)) {
    let mask = (out.resourceMask as unknown[])
      .filter((point): point is Position => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map((point) => [...point] as Position);

    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      let clamped = 0;
      mask = mask.map(([x, y]) => {
        const nx = Math.max(0, Math.min(width, x));
        const ny = Math.max(0, Math.min(height, y));
        if (nx !== x || ny !== y) clamped++;
        return [nx, ny];
      });
      if (clamped > 0) fixes.push(`clamped-mask-points:${clamped}`);
    }

    const normalized = normalizeMask(mask);
    if (normalized.length !== mask.length) fixes.push(`deduped-mask:${mask.length}->${normalized.length}`);
    mask = normalized;

    const epsilon = maskSimplifyEpsilon();
    if (epsilon > 0 && mask.length >= 4) {
      const simplified = simplifyRing(mask, epsilon);
      if (simplified.length >= 3 && simplified.length < mask.length) {
        fixes.push(`simplified-mask:${mask.length}->${simplified.length}`);
        mask = normalizeMask(simplified);
      }
    }

    if (hasSelfIntersections(mask)) {
      const hull = convexHull(mask);
      if (hull.length >= 3 && !hasSelfIntersections(hull)) {
        fixes.push(`repaired-mask-self-intersection:${mask.length}->${hull.length}`);
        mask = hull;
      }
    }
    out.resourceMask = mask;
  }

  if (Array.isArray(out.gcps)) {
    const seenResource = new Set<string>();
    const seenGeo = new Set<string>();
    let removedResource = 0;
    let removedGeo = 0;
    out.gcps = (out.gcps as Array<Record<string, unknown>>).filter((gcp) => {
      const resource = gcp.resource;
      const geo = gcp.geo;
      if (Array.isArray(resource)) {
        const key = pointKey([Number(resource[0]), Number(resource[1])], 9);
        if (seenResource.has(key)) { removedResource++; return false; }
        seenResource.add(key);
      }
      if (Array.isArray(geo)) {
        const key = pointKey([Number(geo[0]), Number(geo[1])], 12);
        if (seenGeo.has(key)) { removedGeo++; return false; }
        seenGeo.add(key);
      }
      return true;
    });
    if (removedResource > 0) fixes.push(`removed-duplicate-resource-gcp:${removedResource}`);
    if (removedGeo > 0) fixes.push(`removed-duplicate-geo-gcp:${removedGeo}`);
  }

  return { map: out, fixes };
}

export function analyzeAndSanitize(georeferencedMap: Record<string, unknown>): { map: Record<string, unknown>; analysis: MapAnalysis } {
  const before = analyzeMap(georeferencedMap);
  if (!hasFixableIssue(before)) return { map: georeferencedMap, analysis: { before, after: before, fixes: [] } };
  const sanitized = sanitizeForAnalysis(georeferencedMap);
  return { map: sanitized.map, analysis: { before, after: analyzeMap(sanitized.map), fixes: sanitized.fixes } };
}

export type WarpFailure = { canvasId: string; manifestUrl?: string; reason: string };

/** Append per-canvas warp failures (with the concrete reason) to IIIFWarnings.log. */
export async function writeWarpFailureLog(buildLog: BuildLog | undefined, layerId: string, failures: WarpFailure[]): Promise<void> {
  if (!buildLog || failures.length === 0) return;
  await buildLog.section(`IIIF Warp Failures: ${layerId}`);
  for (const failure of failures) {
    await buildLog.info(`  ${failure.canvasId}  —  ${failure.reason}${failure.manifestUrl ? `  (${failure.manifestUrl})` : ""}`);
  }
}

export function summarizeAnalysisItems(items: AnalysisItem[]): string {
  return [...new Set(items.map((item) => item.code))].join(", ");
}

function formatAnalysisItems(items: AnalysisItem[]): string {
  return items.map((item) => `${item.code}: ${item.message}`).join(" | ");
}

function possibleFix(analysis: MapAnalysis, skipped: boolean): string | undefined {
  if (analysis.fixes.length > 0) return analysis.fixes.join(", ");
  return skipped ? "manual review in Allmaps" : undefined;
}

export async function writeAnalysisLog(
  buildLog: BuildLog | undefined,
  params: {
    layerId: string;
    manifestUrl: string;
    manifestLabel: string;
    canvasId: string;
    canvasAllmapsId: string;
    serviceId: string;
    analysis: MapAnalysis;
    skipped: boolean;
  },
): Promise<void> {
  if (!buildLog) return;
  const hasErrors = params.analysis.after.errors.length > 0;
  const hasWarnings = params.analysis.after.warnings.length > 0;
  const hasFixes = params.analysis.fixes.length > 0;
  if (!hasErrors && !hasWarnings && !hasFixes) return;
  const issues = [...params.analysis.after.errors, ...params.analysis.after.warnings];

  await buildLog.section(`IIIF Analysis: ${params.layerId}`);
  await buildLog.fields({
    "canvas url": params.canvasId,
    skipped: params.skipped ? "yes" : "no",
    warnings: issues.length > 0 ? formatAnalysisItems(issues) : undefined,
    "possible fix": possibleFix(params.analysis, params.skipped),
  });
}
