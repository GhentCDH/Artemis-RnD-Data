import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateId } from "@allmaps/id";
import type { LayerRef } from "../layers/discovery";
import { allmapsCanvasCacheDir, iiifCacheDir } from "../paths";
import { ensureDir } from "../utils/files";
import { ANNOTATIONS_API, SKIP_MANIFEST_TERMS } from "./config";
import { fetchJson, pathExists, revalidatedJson, sha1 } from "./json";
import type { IiifSublayer, ManifestRef } from "./types";

export function textValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(textValues);
  return [];
}

export function iiifLabel(value: unknown): string {
  return textValues(value)[0] ?? "";
}

export function resourceType(value: Record<string, unknown>): string {
  return String(value.type ?? value["@type"] ?? "");
}

export function resourceId(value: Record<string, unknown>): string {
  return String(value.id ?? value["@id"] ?? "");
}

export function shouldSkipManifest(value: Record<string, unknown>): boolean {
  const text = [
    value.label,
    value.metadata,
    value.keywords,
    value.tags,
    value.behavior,
    value.summary,
    value.description,
  ].flatMap(textValues).join(" ").toLowerCase();
  return SKIP_MANIFEST_TERMS.some((term) => text.includes(term));
}

export async function resolveIiifResource(url: string): Promise<{ label: string; refs: ManifestRef[] }> {
  const json = await revalidatedJson(url, iiifCacheDir("collections"));
  if (!json || typeof json !== "object") throw new Error(`${url} did not resolve to an object`);
  const data = json as Record<string, unknown>;
  const type = resourceType(data);
  const label = iiifLabel(data.label);

  if (type.includes("Manifest")) {
    return { label, refs: shouldSkipManifest(data) ? [] : [{ url, label }] };
  }
  if (!type.includes("Collection")) throw new Error(`Unsupported IIIF resource type for ${url}: ${type || "unknown"}`);

  const items = (Array.isArray(data.items) ? data.items : Array.isArray(data.manifests) ? data.manifests : []) as Array<Record<string, unknown>>;
  const refs: ManifestRef[] = [];
  for (const item of items) {
    const itemType = resourceType(item);
    const itemUrl = resourceId(item);
    if (!itemUrl) continue;
    if (itemType.includes("Collection")) refs.push(...(await resolveIiifResource(itemUrl)).refs);
    else if (itemType.includes("Manifest") && !shouldSkipManifest(item)) refs.push({ url: itemUrl, label: iiifLabel(item.label) });
  }
  return { label, refs };
}

export function iiifSublayers(layer: LayerRef): IiifSublayer[] {
  return (layer.config.sublayers ?? [])
    .filter((sublayer) => sublayer.kind === "iiif" && sublayer.source?.type !== "planned" && typeof sublayer.source?.url === "string")
    .map((sublayer) => ({ id: sublayer.id, url: sublayer.source!.url! }));
}

export function manifestCanvases(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
  const v2 = (manifest.sequences as Array<Record<string, unknown>> | undefined)?.[0]?.canvases;
  if (Array.isArray(v2)) return v2 as Array<Record<string, unknown>>;
  return Array.isArray(manifest.items) ? manifest.items as Array<Record<string, unknown>> : [];
}

export function canvasId(canvas: Record<string, unknown>): string {
  return resourceId(canvas);
}

export function canvasImageService(canvas: Record<string, unknown>): string {
  const v2Images = canvas.images as Array<Record<string, unknown>> | undefined;
  for (const image of v2Images ?? []) {
    const resource = image.resource as Record<string, unknown> | undefined;
    const service = resource?.service;
    const selected = Array.isArray(service) ? service[0] : service;
    const id = selected && typeof selected === "object" ? resourceId(selected as Record<string, unknown>) : "";
    if (id) return id.replace(/\/+$/, "");
  }

  const items = canvas.items as Array<Record<string, unknown>> | undefined;
  for (const page of items ?? []) {
    for (const annotation of (page.items as Array<Record<string, unknown>> | undefined) ?? []) {
      const body = annotation.body;
      const selectedBody = Array.isArray(body) ? body[0] : body;
      if (!selectedBody || typeof selectedBody !== "object") continue;
      const service = (selectedBody as Record<string, unknown>).service;
      const selected = Array.isArray(service) ? service[0] : service;
      const id = selected && typeof selected === "object" ? resourceId(selected as Record<string, unknown>) : "";
      if (id) return id.replace(/\/+$/, "");
    }
  }
  return "";
}

export async function mirrorCanvasAnnotation(canvasAllmapsId: string): Promise<Record<string, unknown> | null> {
  // Re-fetch each run so an upstream re-georeference is detected; the on-disk
  // mirror is a write-through cache used only as an offline fallback.
  const path = join(allmapsCanvasCacheDir(), `${canvasAllmapsId}.json`);
  try {
    const res = await fetch(`${ANNOTATIONS_API}/canvases/${canvasAllmapsId}`, { redirect: "follow" });
    if (res.status !== 200) return null;
    const json = await res.json() as Record<string, unknown>;
    await ensureDir(dirname(path));
    await writeFile(path, JSON.stringify(json, null, 2), "utf-8");
    return json;
  } catch (err) {
    if (await pathExists(path)) return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    throw err;
  }
}

export async function fetchManifestAnnotation(manifestAllmapsId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${ANNOTATIONS_API}/manifests/${manifestAllmapsId}`, { redirect: "follow" });
  if (res.status !== 200) return null;
  return res.json() as Promise<Record<string, unknown>>;
}

export async function extractManifestCanvasAnnotation(
  manifestAllmapsId: string,
  canvasAllmapsId: string,
  serviceUrl: string,
  manifestAnnotation?: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  // Always re-derive from the (freshly fetched) manifest annotation page so
  // upstream georeference edits propagate; only fall back to the cached copy
  // when the manifest annotation can't be fetched at all.
  const path = join(allmapsCanvasCacheDir(), `${canvasAllmapsId}.json`);
  const page = manifestAnnotation ?? await fetchManifestAnnotation(manifestAllmapsId).catch(() => null);
  if (!page) {
    if (await pathExists(path)) return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    return null;
  }
  const items = Array.isArray(page.items) ? page.items as Array<Record<string, unknown>> : [];
  const normalized = serviceUrl.replace(/\/+$/, "");
  const matching = items.filter((item) => {
    const target = item.target as Record<string, unknown> | undefined;
    const source = target?.source;
    const sourceId = typeof source === "string" ? source : source && typeof source === "object" ? resourceId(source as Record<string, unknown>) : "";
    return sourceId.replace(/\/+$/, "") === normalized;
  });
  if (matching.length === 0) return null;

  const synthetic = { id: `${ANNOTATIONS_API}/canvases/${canvasAllmapsId}`, type: "AnnotationPage", "@context": "http://www.w3.org/ns/anno.jsonld", items: matching };
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(synthetic, null, 2), "utf-8");
  return synthetic;
}

export function pruneInfo(info: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!info) return null;
  const out = { ...info };
  delete out.sizes;
  return out;
}

export async function infoJson(serviceUrl: string): Promise<Record<string, unknown> | null> {
  const normalized = serviceUrl.replace(/\/+$/, "");
  const path = join(iiifCacheDir("info"), `${sha1(normalized)}.json`);
  if (await pathExists(path)) return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  try {
    const info = await fetchJson(`${normalized}/info.json`) as Record<string, unknown>;
    await ensureDir(dirname(path));
    await writeFile(path, JSON.stringify(info, null, 2), "utf-8");
    return info;
  } catch {
    return null;
  }
}
