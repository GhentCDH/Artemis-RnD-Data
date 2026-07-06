import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateId } from "@allmaps/id";
import sharp from "sharp";
import YAML from "yaml";
import type { BuildLog } from "../build/buildLog";
import { runPool } from "../concurrency";
import { canvasImageService, infoJson, manifestCanvases, resourceId } from "../iiif/iiif";
import { fetchJson, revalidatedJson, sha1 } from "../iiif/json";
import { calculateSpriteSize, fetchSprite, packSprites } from "../iiif/sprites";
import type { SpriteSource } from "../iiif/types";
import { log } from "../log";
import {
  BUILD_IMAGE_COLLECTION_YAML_PATH,
  imageCollectionConfigPath,
  imageCollectionCacheDir,
  imageCollectionOutDir,
} from "../paths";
import { ensureDir, fileExists, writeJson } from "../utils/files";
import { contentHash, stableStringify } from "../utils/hash";

const IMAGE_COLLECTION_RECIPE = 3;

type ImageCollectionConfigFile = {
  collections?: ImageCollectionConfig[];
};

type ImageCollectionConfig = {
  id: string;
  label: string;
  provider?: string;
  description?: string;
  attribution?: unknown;
  source: {
    adapter: "primo-api" | "iiif-collection";
    catalogBaseUrl?: string;
    search?: {
      endpoint?: string;
      query?: Record<string, string | number | boolean>;
    };
    pagination?: {
      limit?: number;
      recordsPath?: string;
      totalPath?: string;
    };
    resolveManifest?: {
      step?: {
        endpoint?: string;
        method?: "GET" | "POST";
        pick?: string;
        extract?: string;
        as?: string;
      };
      template?: string;
    };
    url?: string;
  };
  map?: Record<string, FieldMapping>;
};

type FieldMapping = {
  path?: string;
  from?: string;
  transform?: TransformSpec;
  transforms?: TransformSpec[];
};

type TransformSpec = Record<string, Record<string, unknown> | undefined>;

type RawRecord = {
  source: Record<string, unknown>;
  recordId: string;
  manifestUrl: string;
  repId?: string;
};

export type ImageCollectionItem = {
  id: string;
  title: string;
  year?: string;
  location?: string;
  lat?: number;
  lon?: number;
  manifestUrl: string;
  recordId: string;
  repId?: string;
  searchText: string;
};

export type ImageCollectionBuildResult = {
  id: string;
  label: string;
  provider?: string;
  description?: string;
  attribution?: unknown;
  totalItems: number;
  coordsAvailable: number;
  indexPath: string;
  spritesImagePath?: string;
  spritesJsonPath?: string;
  cached?: boolean;
};

export type BuildImageCollectionsOptions = {
  selectedIds?: string[];
  concurrency: number;
  force?: boolean;
  buildLog?: BuildLog;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function getPath(value: unknown, path?: string): unknown {
  if (!path) return undefined;
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (typeof current === "object") current = (current as Record<string, unknown>)[part];
    else return undefined;
  }
  return current;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(firstString).find((item): item is string => Boolean(item));
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringArray);
  return [];
}

function regexFromConfig(value: unknown): RegExp | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const slash = value.match(/^\/(.+)\/([a-z]*)$/i);
  return slash ? new RegExp(slash[1], slash[2]) : new RegExp(value);
}

function applyTransform(value: unknown, spec: TransformSpec): unknown {
  const [name, rawOptions] = Object.entries(spec)[0] ?? [];
  const options = asRecord(rawOptions);
  if (!name) return value;
  if (name === "title-clean") {
    let text = firstString(value) ?? "";
    const keepColon = options.keepColon === true;
    for (const marker of stringArray(options.stripAfter)) {
      if (keepColon && marker.includes(":")) continue;
      const index = text.indexOf(marker);
      if (index >= 0) text = text.slice(0, index);
    }
    return text.trim();
  }
  if (name === "year-regex") {
    return firstString(value)?.match(/\b(\d{4})\b/)?.[1];
  }
  if (name === "pick-subject") {
    const prefix = firstString(options.prefix) ?? "";
    const drop = new Set(stringArray(options.drop));
    const subjects = stringArray(value);
    const prefixed = subjects.find((item) => prefix && item.startsWith(prefix));
    if (prefixed) return prefixed.slice(prefix.length).trim();
    return subjects.find((item) => !drop.has(item));
  }
  if (name === "dms") {
    const text = firstString(value) ?? "";
    const m = text.match(/(\d+)°(\d+)'(\d+)[""″]\s*(NB|ZB)\s+(\d+)°(\d+)'(\d+)[""″]\s*(OL|WL)/);
    if (!m) return undefined;
    const lat = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
    const lon = Number(m[5]) + Number(m[6]) / 60 + Number(m[7]) / 3600;
    return { lat: m[4] === "ZB" ? -lat : lat, lon: m[8] === "WL" ? -lon : lon };
  }
  return value;
}

function mappedValue(record: RawRecord, mapping: FieldMapping, values: Record<string, unknown>): unknown {
  let value = mapping.from ? values[mapping.from] : getPath(record.source, mapping.path);
  for (const transform of [...(mapping.transforms ?? []), ...(mapping.transform ? [mapping.transform] : [])]) {
    value = applyTransform(value, transform);
  }
  return value;
}

function normalizeRecord(collection: ImageCollectionConfig, record: RawRecord): ImageCollectionItem {
  const values: Record<string, unknown> = {};
  for (const [key, mapping] of Object.entries(collection.map ?? {})) {
    values[key] = mappedValue(record, mapping, values);
  }
  const coords = asRecord(values.coordinates);
  const title = firstString(values.label) ?? firstString(getPath(record.source, "pnx.display.title.0")) ?? record.recordId;
  const year = firstString(values.year);
  const location = firstString(values.location);
  const lat = typeof coords.lat === "number" ? roundCoordinate(coords.lat) : undefined;
  const lon = typeof coords.lon === "number" ? roundCoordinate(coords.lon) : undefined;
  return {
    id: record.repId ?? record.recordId,
    title,
    year,
    location,
    lat,
    lon,
    manifestUrl: record.manifestUrl,
    recordId: record.recordId,
    repId: record.repId,
    searchText: [title, year, location, collection.label, collection.provider].filter(Boolean).join(" "),
  };
}

async function readConfig(): Promise<ImageCollectionConfig[]> {
  const parsed = YAML.parse(await readFile(imageCollectionConfigPath(), "utf-8")) as ImageCollectionConfigFile | null;
  return (parsed?.collections ?? []).filter((collection) => collection.id && collection.label);
}

async function fetchPrimoJson(url: string, method: "GET" | "POST" = "GET"): Promise<unknown> {
  if (!/^https?:\/\/libcatalog\.ugent\.be\//.test(url)) return fetchJson(url);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
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
      if (res.ok) return res.json();
      lastError = new Error(`Primo API ${res.status} ${method} ${url}`);
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
    } catch (err) {
      lastError = err;
    }
    if (attempt < 3) await Bun.sleep(300 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function defaultPrimoParams(): Record<string, string> {
  return {
    citationTrailFilterByAvailability: "true",
    newspapersActive: "false",
    newspapersSearch: "false",
    pcAvailability: "false",
    scope: "MyInst_and_CI",
    searchInFulltextUserSelection: "false",
    disableCache: "false",
    skipDelivery: "N",
    sort: "rank",
    tab: "Everything",
    rapido: "true",
    refEntryActive: "true",
    rtaLinks: "true",
    qInclude: "",
    qExclude: "",
    mode: "advanced",
    isCDSearch: "false",
    featuredNewspapersIssnList: "",
    explain: "",
    otbRanking: "",
    isRelatedItems: "false",
  };
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => values[key] ?? "");
}

async function fetchPrimoRecords(collection: ImageCollectionConfig): Promise<RawRecord[]> {
  const source = collection.source;
  const base = source.catalogBaseUrl?.replace(/\/+$/, "");
  const endpoint = source.search?.endpoint ?? "/pnxs";
  if (!base) throw new Error(`${collection.id}: primo-api source requires catalogBaseUrl`);
  const limit = source.pagination?.limit ?? 10;
  const recordsPath = source.pagination?.recordsPath ?? "docs";
  const totalPath = source.pagination?.totalPath ?? "info.total";
  const query = { ...defaultPrimoParams(), ...(source.search?.query ?? {}) };

  const fetchPage = async (offset: number): Promise<{ docs: Record<string, unknown>[]; total: number }> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) params.set(key, String(value));
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    const json = await fetchPrimoJson(`${base}${endpoint}?${params}`);
    const docs = getPath(json, recordsPath);
    return {
      docs: Array.isArray(docs) ? docs as Record<string, unknown>[] : [],
      total: Number(getPath(json, totalPath) ?? 0),
    };
  };

  const first = await fetchPage(0);
  const offsets = Array.from({ length: Math.ceil(first.total / limit) }, (_, index) => index * limit).slice(1);
  const pages: Array<{ docs: Record<string, unknown>[]; total: number }> = [];
  for (const offset of offsets) {
    pages.push(await fetchPage(offset));
    await Bun.sleep(100);
  }
  const docs = [first, ...pages].flatMap((page) => page.docs);
  const step = source.resolveManifest?.step;
  const template = source.resolveManifest?.template;
  if (!step?.endpoint || !template) throw new Error(`${collection.id}: primo-api source requires resolveManifest.step and template`);
  const extract = regexFromConfig(step.extract);

  const records: RawRecord[] = [];
  for (const doc of docs) {
    const recordId = firstString(getPath(doc, "pnx.control.recordid.0"));
    if (!recordId) continue;
    const linkParams = new URLSearchParams();
    if (query.lang !== undefined) linkParams.set("lang", String(query.lang));
    if (query.vid !== undefined) linkParams.set("vid", String(query.vid));
    const suffix = linkParams.size > 0 ? `?${linkParams}` : "";
    const url = `${base}${fillTemplate(step.endpoint, { recordId })}${suffix}`;
    const linked = asRecord(await fetchPrimoJson(url, step.method ?? "GET"));
    const picked = firstString(getPath(linked, step.pick));
    const repId = extract && picked ? picked.match(extract)?.[1] : picked;
    if (!repId) continue;
    records.push({
      source: doc,
      recordId,
      repId,
      manifestUrl: fillTemplate(template, { recordId, repId }),
    });
    await Bun.sleep(60);
  }
  return records;
}

async function fetchIiifCollectionRecords(collection: ImageCollectionConfig): Promise<RawRecord[]> {
  if (!collection.source.url) throw new Error(`${collection.id}: iiif-collection source requires url`);
  const json = asRecord(await revalidatedJson(collection.source.url, imageCollectionCacheDir("api")));
  const items = (Array.isArray(json.items) ? json.items : Array.isArray(json.manifests) ? json.manifests : []) as Record<string, unknown>[];
  return items.map((item) => ({
    source: item,
    recordId: resourceId(item),
    manifestUrl: resourceId(item),
  })).filter((item) => item.manifestUrl);
}

async function fetchRawRecords(collection: ImageCollectionConfig): Promise<RawRecord[]> {
  if (collection.source.adapter === "primo-api") return fetchPrimoRecords(collection);
  if (collection.source.adapter === "iiif-collection") return fetchIiifCollectionRecords(collection);
  throw new Error(`${collection.id}: unsupported adapter ${String(collection.source.adapter)}`);
}

async function spriteSourceForItem(collection: ImageCollectionConfig, item: ImageCollectionItem): Promise<SpriteSource | null> {
  const manifest = asRecord(await revalidatedJson(item.manifestUrl, imageCollectionCacheDir("manifests")));
  const canvas = manifestCanvases(manifest)[0];
  if (!canvas) return null;
  const serviceId = canvasImageService(canvas);
  if (!serviceId) return null;
  const info = await infoJson(serviceId);
  const width = Number(info?.width);
  const height = Number(info?.height);
  if (!info || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const size = calculateSpriteSize(width, height);
  const spriteId = item.repId ?? await generateId(item.manifestUrl);
  const buffer = await fetchSprite(serviceId, info, size, join(imageCollectionCacheDir("sprites"), collection.id, `${spriteId}_${size.width}x${size.height}.jpg`));
  return {
    canvasAllmapsId: item.id,
    imageId: serviceId,
    fullWidth: width,
    fullHeight: height,
    spriteWidth: size.width,
    spriteHeight: size.height,
    buffer,
  };
}

async function writeSpriteArtifacts(collection: ImageCollectionConfig, outDir: string, items: ImageCollectionItem[], concurrency: number): Promise<{ image: string; json: string; imageSize: [number, number]; count: number } | undefined> {
  const sources: SpriteSource[] = [];
  await runPool(items, concurrency, async (item) => {
    const source = await spriteSourceForItem(collection, item).catch(() => null);
    if (source) sources.push(source);
  });
  if (sources.length === 0) return undefined;
  const packed = packSprites(sources);
  const imageName = `${collection.id}_sprites.webp`;
  const jsonName = `${collection.id}_sprites.json`;
  await sharp({
    create: { width: packed.width, height: packed.height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite(packed.placements.map((placement) => ({ input: placement.buffer, left: placement.x, top: placement.y })))
    .webp({ quality: 75 })
    .toFile(join(outDir, imageName));

  const spritesJson: Record<string, unknown> = {};
  for (const placement of packed.placements) {
    spritesJson[placement.canvasAllmapsId] = {
      imageId: placement.imageId,
      scaleFactor: Math.max(placement.fullWidth / placement.spriteWidth, placement.fullHeight / placement.spriteHeight),
      x: placement.x,
      y: placement.y,
      width: placement.spriteWidth,
      height: placement.spriteHeight,
    };
  }
  await writeJson(join(outDir, jsonName), spritesJson, true);
  return {
    image: `Image collections/${collection.id}/${imageName}`,
    json: `Image collections/${collection.id}/${jsonName}`,
    imageSize: [packed.width, packed.height],
    count: packed.placements.length,
  };
}

async function readHashes(path: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!await fileExists(path)) return map;
  for (const line of (await readFile(path, "utf-8")).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const gap = trimmed.indexOf(" ");
    if (gap > 0) map.set(trimmed.slice(gap).trim(), trimmed.slice(0, gap).trim());
  }
  return map;
}

async function writeHashes(path: string, entries: Array<[string, string]>): Promise<void> {
  const body = uniqueHashEntries(entries)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([source, hash]) => `${hash}  ${source}`)
    .join("\n");
  await ensureDir(dirname(path));
  await writeFile(path, `# Image collection source data-hash registry.\n# Format: <sha256>  <source>\n${body}\n`, "utf-8");
}

function hashesUnchanged(prev: Map<string, string>, entries: Array<[string, string]>): boolean {
  const unique = uniqueHashEntries(entries);
  if (prev.size !== unique.length) return false;
  return unique.every(([source, hash]) => prev.get(source) === hash);
}

function uniqueHashEntries(entries: Array<[string, string]>): Array<[string, string]> {
  return [...new Map(entries).entries()];
}

async function previousItemCount(path: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as { totalItems?: unknown };
    return typeof parsed.totalItems === "number" ? parsed.totalItems : undefined;
  } catch {
    return undefined;
  }
}

async function buildCollection(collection: ImageCollectionConfig, options: BuildImageCollectionsOptions): Promise<ImageCollectionBuildResult> {
  const outDir = imageCollectionOutDir(collection.id);
  const indexName = `${collection.id}_index.json`;
  const indexPath = join(outDir, indexName);
  const spritesImagePath = join(outDir, `${collection.id}_sprites.webp`);
  const spritesJsonPath = join(outDir, `${collection.id}_sprites.json`);
  const rawRecords = await fetchRawRecords(collection);
  const items = rawRecords.map((record) => normalizeRecord(collection, record));
  const previousTotal = await previousItemCount(indexPath);
  if (!options.force && previousTotal !== undefined && items.length < previousTotal) {
    throw new Error(`${collection.id}: fetched ${items.length} image records, below existing ${previousTotal}; refusing to overwrite with a partial collection`);
  }
  const hashEntries: Array<[string, string]> = [
    ["@config", contentHash(IMAGE_COLLECTION_RECIPE, collection)],
    ["@items", contentHash(items.map(({ searchText: _searchText, ...item }) => item))],
    ["@sprites", contentHash("sprites", IMAGE_COLLECTION_RECIPE)],
  ];
  for (const item of items) hashEntries.push([item.manifestUrl, sha1(item.manifestUrl)]);
  const hashesPath = join(outDir, "hashes.txt");
  const unchanged = hashesUnchanged(await readHashes(hashesPath), hashEntries);
  if (!options.force && unchanged && await fileExists(indexPath) && await fileExists(spritesImagePath) && await fileExists(spritesJsonPath)) {
    log.ok(`${collection.id}: image collection unchanged — skipped`);
    return {
      id: collection.id,
      label: collection.label,
      provider: collection.provider,
      description: collection.description,
      attribution: collection.attribution,
      totalItems: items.length,
      coordsAvailable: items.filter((item) => item.lat !== undefined && item.lon !== undefined).length,
      indexPath,
      spritesImagePath,
      spritesJsonPath,
      cached: true,
    };
  }

  await ensureDir(outDir);
  const sprites = await writeSpriteArtifacts(collection, outDir, items, options.concurrency);
  const index = {
    generatedAt: new Date().toISOString(),
    id: collection.id,
    label: collection.label,
    provider: collection.provider,
    description: collection.description,
    attribution: collection.attribution,
    totalItems: items.length,
    coordsAvailable: items.filter((item) => item.lat !== undefined && item.lon !== undefined).length,
    sprites,
    items,
  };
  await writeJson(indexPath, index, true);
  await writeHashes(hashesPath, hashEntries);
  log.ok(`${collection.id}: ${items.length} image records, ${sprites?.count ?? 0} sprites`);
  return {
    id: collection.id,
    label: collection.label,
    provider: collection.provider,
    description: collection.description,
    attribution: collection.attribution,
    totalItems: items.length,
    coordsAvailable: index.coordsAvailable,
    indexPath,
    spritesImagePath: sprites ? join(outDir, `${collection.id}_sprites.webp`) : undefined,
    spritesJsonPath: sprites ? join(outDir, `${collection.id}_sprites.json`) : undefined,
  };
}

async function publishImageCollectionYaml(results: ImageCollectionBuildResult[], force = false): Promise<void> {
  const collections = results.map((result) => ({
    id: result.id,
    label: result.label,
    provider: result.provider,
    description: result.description,
    attribution: result.attribution,
    totalItems: result.totalItems,
    coordsAvailable: result.coordsAvailable,
    artifacts: {
      index: `Image collections/${result.id}/${result.id}_index.json`,
      ...(result.spritesImagePath ? { sprites: `Image collections/${result.id}/${result.id}_sprites.webp` } : {}),
      ...(result.spritesJsonPath ? { spritesIndex: `Image collections/${result.id}/${result.id}_sprites.json` } : {}),
    },
  }));
  if (!force) {
    try {
      const current = YAML.parse(await readFile(BUILD_IMAGE_COLLECTION_YAML_PATH, "utf-8")) as { buildRecipe?: unknown; collections?: unknown };
      if (current?.buildRecipe === IMAGE_COLLECTION_RECIPE && stableStringify(current.collections) === stableStringify(collections)) {
        log.ok(`imagecollection: unchanged — skipped (${BUILD_IMAGE_COLLECTION_YAML_PATH})`);
        return;
      }
    } catch {
      // Missing or invalid output: write below.
    }
  }
  const header =
    "# build/imagecollection.yaml — published non-georeferenced image collections.\n" +
    "# Generated by `bun run src/cli.ts imagecollections`; do not edit by hand.\n";
  await ensureDir(dirname(BUILD_IMAGE_COLLECTION_YAML_PATH));
  await writeFile(BUILD_IMAGE_COLLECTION_YAML_PATH, `${header}${YAML.stringify({ generatedAt: new Date().toISOString(), buildRecipe: IMAGE_COLLECTION_RECIPE, collections }, { lineWidth: 0 })}`, "utf-8");
  log.ok(`imagecollection: ${collections.length} collections → ${BUILD_IMAGE_COLLECTION_YAML_PATH}`);
}

export async function buildImageCollections(options: BuildImageCollectionsOptions): Promise<ImageCollectionBuildResult[]> {
  const selected = new Set(options.selectedIds ?? []);
  const collections = (await readConfig()).filter((collection) => selected.size === 0 || selected.has(collection.id));
  if (collections.length === 0) {
    log.warn("no image collections found");
    return [];
  }
  const results: ImageCollectionBuildResult[] = [];
  for (const collection of collections) {
    const result = options.buildLog
      ? await options.buildLog.timed(`imagecollection:${collection.id}`, () => buildCollection(collection, options))
      : await buildCollection(collection, options);
    results.push(result);
    await options.buildLog?.section(`Image Collection: ${collection.id}`);
    await options.buildLog?.fields({
      items: result.totalItems,
      "with coordinates": result.coordsAvailable,
      index: result.indexPath,
      sprites: result.spritesImagePath,
    });
  }
  await publishImageCollectionYaml(results, options.force);
  await options.buildLog?.section("Image Collections Summary");
  await options.buildLog?.fields({
    collections: results.length,
    items: results.reduce((sum, result) => sum + result.totalItems, 0),
    "with coordinates": results.reduce((sum, result) => sum + result.coordsAvailable, 0),
    output: BUILD_IMAGE_COLLECTION_YAML_PATH,
  });
  return results;
}
