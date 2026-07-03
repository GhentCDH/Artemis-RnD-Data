import { stableJson } from "./json";
import type { CompactGeomap, ProcessedCanvas, ProcessedManifest } from "./types";

function stripInfoVariableFields(info: Record<string, unknown> | null): Record<string, unknown> {
  if (!info) return {};
  const out = { ...info };
  delete out["@id"];
  delete out.id;
  delete out.width;
  delete out.height;
  delete out.sizes;
  return out;
}

function mostCommonIiifDefaults(canvases: ProcessedCanvas[]): Record<string, unknown> {
  const counts = new Map<string, { value: Record<string, unknown>; count: number }>();
  for (const canvas of canvases) {
    const defaults = stripInfoVariableFields(canvas.info);
    if (Object.keys(defaults).length === 0) continue;
    const key = stableJson(defaults);
    const current = counts.get(key);
    counts.set(key, { value: defaults, count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.value ?? {};
}

function commonStringPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix) && prefix.length > 0) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function baseImageUrl(canvases: ProcessedCanvas[]): string {
  const ids = canvases
    .map((canvas) => {
      const resource = canvas.georeferencedMap.resource as Record<string, unknown> | undefined;
      return String(resource?.id ?? canvas.serviceId ?? "");
    })
    .filter(Boolean);
  const slash = commonStringPrefix(ids).lastIndexOf("/");
  return slash >= 0 ? commonStringPrefix(ids).slice(0, slash + 1) : "";
}

function transformationCode(georeferencedMap: Record<string, unknown>): string {
  const transformation = georeferencedMap.transformation as Record<string, unknown> | undefined;
  const type = String(transformation?.type ?? "polynomial");
  if (type !== "polynomial") return type;
  const options = transformation?.options as Record<string, unknown> | undefined;
  const order = Number(options?.order);
  return `polynomial${Number.isFinite(order) ? order : 1}`;
}

function flatGcps(georeferencedMap: Record<string, unknown>): Array<[number, number, number, number]> {
  const gcps = Array.isArray(georeferencedMap.gcps) ? georeferencedMap.gcps as Array<Record<string, unknown>> : [];
  return gcps.flatMap((gcp) => {
    const resource = gcp.resource;
    const geo = gcp.geo;
    if (!Array.isArray(resource) || !Array.isArray(geo)) return [];
    const tuple: [number, number, number, number] = [Number(resource[0]), Number(resource[1]), Number(geo[0]), Number(geo[1])];
    return tuple.every(Number.isFinite) ? [tuple] : [];
  });
}

function flatResourceMask(georeferencedMap: Record<string, unknown>): number[] | undefined {
  const mask = Array.isArray(georeferencedMap.resourceMask) ? georeferencedMap.resourceMask as unknown[] : [];
  const flat = mask.flatMap((point) => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : []);
  return flat.length > 0 && flat.every(Number.isFinite) ? flat : undefined;
}

function compactMapId(imageId: string, manifest: ProcessedManifest, canvasIndex: number): string {
  if (imageId.includes(":")) return imageId;
  return imageId.split("/").filter(Boolean).at(-1) ?? `${manifest.manifestAllmapsId}:${canvasIndex + 1}`;
}

export function buildCompactGeomaps(layerId: string, processed: ProcessedManifest[]): Record<string, unknown> {
  const canvases = processed.flatMap((manifest) => manifest.canvases);
  const base = baseImageUrl(canvases);
  const iiifDefaults = mostCommonIiifDefaults(canvases);
  const defaultsKey = stableJson(iiifDefaults);
  const maps: CompactGeomap[] = [];

  for (const manifest of processed) {
    manifest.canvases.forEach((canvas, canvasIndex) => {
      const resource = canvas.georeferencedMap.resource as Record<string, unknown> | undefined;
      const resourceId = String(resource?.id ?? canvas.serviceId ?? "");
      const imageId = base && resourceId.startsWith(base) ? resourceId.slice(base.length) : resourceId;
      const width = Number(resource?.width ?? canvas.info?.width);
      const height = Number(resource?.height ?? canvas.info?.height);
      if (!imageId || !Number.isFinite(width) || !Number.isFinite(height)) return;

      const entryDefaults = stripInfoVariableFields(canvas.info);
      const overrides = stableJson(entryDefaults) === defaultsKey ? undefined : entryDefaults;
      const resourceMask = flatResourceMask(canvas.georeferencedMap);
      maps.push({
        id: compactMapId(imageId, manifest, canvasIndex),
        label: manifest.canvases.length > 1 ? `${manifest.manifestLabel} (${canvasIndex + 1})` : manifest.manifestLabel,
        imageId,
        width,
        height,
        transformation: transformationCode(canvas.georeferencedMap),
        gcps: flatGcps(canvas.georeferencedMap),
        ...(resourceMask ? { resourceMask } : {}),
        ...(overrides && Object.keys(overrides).length > 0 ? { iiifOverrides: overrides } : {}),
      });
    });
  }

  return { geomapsVersion: 1, generatedAt: new Date().toISOString(), id: layerId, baseImageUrl: base, iiifDefaults, maps };
}
