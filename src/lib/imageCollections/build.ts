import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateId } from "@allmaps/id";
import sharp from "sharp";
import YAML from "yaml";
import type { BuildLog } from "../build/buildLog";
import { runPool } from "../concurrency";
import { canvasImageService, iiifLabel, infoJson, manifestCanvases } from "../iiif/iiif";
import { revalidatedJson, sha1 } from "../iiif/json";
import { calculateSpriteSize, fetchSprite, packSprites } from "../iiif/sprites";
import type { SpriteSource } from "../iiif/types";
import { log } from "../log";
import {
  BUILD_IMAGE_COLLECTION_YAML_PATH,
  BUILD_IMAGE_COLLECTIONS_SUMMARY_PATH,
  sourceImageCollectionsDir,
  imageCollectionCacheDir,
  imageCollectionOutDir,
} from "../paths";
import { ensureDir, fileExists, writeJson } from "../utils/files";
import { contentHash, stableStringify } from "../utils/hash";

const IMAGE_COLLECTION_RECIPE = 4;

type ImageCollectionConfig = {
  id: string;
  label: string;
  provider?: string;
  description?: string;
  attribution?: unknown;
};

/** One line of `<Name>Collection.json`: a IIIF manifest URL, optionally paired with [lon, lat]. */
type ManifestEntry = {
  manifestUrl: string;
  /** Explicit coordinates for manifests without navPlace, GeoJSON [lon, lat] order. */
  coordinates?: [number, number];
};

type ImageCollectionSource = {
  config: ImageCollectionConfig;
  entries: ManifestEntry[];
};

export type ImageCollectionItem = {
  id: string;
  title: string;
  lat?: number;
  lon?: number;
  manifestUrl: string;
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
  /** Manifest URLs grouped by where their coordinates came from (navPlace extension vs paired data in <Name>Collection.json). */
  coordinateSources: { navPlace: string[]; paired: string[] };
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

function isLonLat(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "number" && Number.isFinite(part));
}

/** First [lon, lat] position anywhere inside a GeoJSON coordinates array. */
function firstPosition(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (isLonLat(value)) return value;
  for (const inner of value) {
    const position = firstPosition(inner);
    if (position) return position;
  }
  return undefined;
}

/** Coordinates from a manifest's navPlace extension: the first Point feature, else the first position of any geometry. */
function navPlaceCoordinates(manifest: Record<string, unknown>): { lat: number; lon: number } | undefined {
  const features = asRecord(manifest.navPlace).features;
  if (!Array.isArray(features)) return undefined;
  const geometries = features.map((feature) => asRecord(asRecord(feature).geometry));
  const geometry = geometries.find((entry) => entry.type === "Point") ?? geometries[0];
  const position = firstPosition(geometry?.coordinates);
  return position ? { lon: position[0], lat: position[1] } : undefined;
}

async function readCollectionConfig(root: string, dirName: string): Promise<ImageCollectionConfig> {
  const candidates = [join(root, dirName, `${dirName}.yml`), join(root, dirName, `${dirName}.yaml`)];
  for (const path of candidates) {
    if (!await fileExists(path)) continue;
    const parsed = asRecord(YAML.parse(await readFile(path, "utf-8")));
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const label = typeof parsed.label === "string" ? parsed.label : "";
    if (!id || !label) throw new Error(`${path}: image collection config requires id and label`);
    if (id !== dirName) throw new Error(`${path}: id "${id}" must match containing directory "${dirName}"`);
    return {
      id,
      label,
      provider: typeof parsed.provider === "string" ? parsed.provider : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
      attribution: parsed.attribution,
    };
  }
  throw new Error(`imagecollections/${dirName}: missing ${dirName}.yml`);
}

async function readCollectionEntries(root: string, dirName: string): Promise<ManifestEntry[]> {
  const path = join(root, dirName, `${dirName}Collection.json`);
  if (!await fileExists(path)) throw new Error(`imagecollections/${dirName}: missing ${dirName}Collection.json`);
  const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: must be a JSON object mapping manifest URLs to [lon, lat] or null`);
  }
  const entries: ManifestEntry[] = [];
  for (const [manifestUrl, coordinates] of Object.entries(parsed)) {
    if (coordinates === null) {
      entries.push({ manifestUrl });
      continue;
    }
    if (!isLonLat(coordinates)) throw new Error(`${path}: "${manifestUrl}" must map to [lon, lat] or null`);
    entries.push({ manifestUrl, coordinates });
  }
  return entries;
}

async function discoverImageCollections(selectedIds?: string[]): Promise<ImageCollectionSource[]> {
  const root = sourceImageCollectionsDir();
  const wanted = new Set((selectedIds ?? []).filter(Boolean));
  let dirEntries;
  try {
    dirEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = dirEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => wanted.size === 0 || wanted.has(name))
    .sort((a, b) => a.localeCompare(b));

  const collections: ImageCollectionSource[] = [];
  for (const dirName of dirs) {
    collections.push({
      config: await readCollectionConfig(root, dirName),
      entries: await readCollectionEntries(root, dirName),
    });
  }
  return collections;
}

type CollectionRecord = {
  item: ImageCollectionItem;
  manifest: Record<string, unknown>;
  coordinateSource: "navPlace" | "paired";
};

async function fetchCollectionRecords(source: ImageCollectionSource, concurrency: number): Promise<CollectionRecord[]> {
  const { config, entries } = source;
  const records: Array<CollectionRecord | undefined> = new Array(entries.length);
  const missingNavPlace: string[] = [];
  await runPool(entries.map((entry, index) => ({ entry, index })), concurrency, async ({ entry, index }) => {
    const manifest = asRecord(await revalidatedJson(entry.manifestUrl, imageCollectionCacheDir("manifests")));
    // Titles stay exactly what the source collection publishes - no cleanup.
    const title = iiifLabel(manifest.label) || entry.manifestUrl;
    const coords = entry.coordinates
      ? { lon: entry.coordinates[0], lat: entry.coordinates[1] }
      : navPlaceCoordinates(manifest);
    if (!coords) {
      missingNavPlace.push(entry.manifestUrl);
      return;
    }
    records[index] = {
      manifest,
      coordinateSource: entry.coordinates ? "paired" : "navPlace",
      item: {
        id: await generateId(entry.manifestUrl),
        title,
        lat: roundCoordinate(coords.lat),
        lon: roundCoordinate(coords.lon),
        manifestUrl: entry.manifestUrl,
        searchText: [title, config.label, config.provider].filter(Boolean).join(" "),
      },
    };
  });
  if (missingNavPlace.length > 0) {
    throw new Error(
      `${config.id}: ${missingNavPlace.length} manifest(s) without navPlace need paired [lon, lat] coordinates in ${config.id}Collection.json:\n  - ${missingNavPlace.join("\n  - ")}`,
    );
  }
  return records.filter((record): record is CollectionRecord => record !== undefined);
}

async function spriteSourceForRecord(collection: ImageCollectionConfig, record: CollectionRecord): Promise<SpriteSource | null> {
  const canvas = manifestCanvases(record.manifest)[0];
  if (!canvas) return null;
  const serviceId = canvasImageService(canvas);
  if (!serviceId) return null;
  const info = await infoJson(serviceId);
  const width = Number(info?.width);
  const height = Number(info?.height);
  if (!info || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const size = calculateSpriteSize(width, height);
  const buffer = await fetchSprite(serviceId, info, size, join(imageCollectionCacheDir("sprites"), collection.id, `${record.item.id}_${size.width}x${size.height}.jpg`));
  return {
    canvasAllmapsId: record.item.id,
    imageId: serviceId,
    fullWidth: width,
    fullHeight: height,
    spriteWidth: size.width,
    spriteHeight: size.height,
    buffer,
  };
}

async function writeSpriteArtifacts(collection: ImageCollectionConfig, outDir: string, records: CollectionRecord[], concurrency: number): Promise<{ image: string; json: string; imageSize: [number, number]; count: number } | undefined> {
  const sources: SpriteSource[] = [];
  await runPool(records, concurrency, async (record) => {
    const source = await spriteSourceForRecord(collection, record).catch(() => null);
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

async function buildCollection(source: ImageCollectionSource, options: BuildImageCollectionsOptions): Promise<ImageCollectionBuildResult> {
  const { config, entries } = source;
  const outDir = imageCollectionOutDir(config.id);
  const indexName = `${config.id}_index.json`;
  const indexPath = join(outDir, indexName);
  const spritesImagePath = join(outDir, `${config.id}_sprites.webp`);
  const spritesJsonPath = join(outDir, `${config.id}_sprites.json`);
  const records = await fetchCollectionRecords(source, options.concurrency);
  const items = records.map((record) => record.item);
  const coordinateSources = {
    navPlace: records.filter((record) => record.coordinateSource === "navPlace").map((record) => record.item.manifestUrl),
    paired: records.filter((record) => record.coordinateSource === "paired").map((record) => record.item.manifestUrl),
  };
  const hashEntries: Array<[string, string]> = [
    ["@config", contentHash(IMAGE_COLLECTION_RECIPE, config)],
    ["@entries", contentHash(entries)],
    ["@items", contentHash(items.map(({ searchText: _searchText, ...item }) => item))],
    ["@sprites", contentHash("sprites", IMAGE_COLLECTION_RECIPE)],
  ];
  for (const item of items) hashEntries.push([item.manifestUrl, sha1(item.manifestUrl)]);
  const hashesPath = join(outDir, "hashes.txt");
  const unchanged = hashesUnchanged(await readHashes(hashesPath), hashEntries);
  if (!options.force && unchanged && await fileExists(indexPath) && await fileExists(spritesImagePath) && await fileExists(spritesJsonPath)) {
    log.ok(`${config.id}: image collection unchanged — skipped`);
    return {
      id: config.id,
      label: config.label,
      provider: config.provider,
      description: config.description,
      attribution: config.attribution,
      totalItems: items.length,
      coordsAvailable: items.filter((item) => item.lat !== undefined && item.lon !== undefined).length,
      coordinateSources,
      indexPath,
      spritesImagePath,
      spritesJsonPath,
      cached: true,
    };
  }

  await ensureDir(outDir);
  const sprites = await writeSpriteArtifacts(config, outDir, records, options.concurrency);
  const index = {
    generatedAt: new Date().toISOString(),
    id: config.id,
    label: config.label,
    provider: config.provider,
    description: config.description,
    attribution: config.attribution,
    totalItems: items.length,
    coordsAvailable: items.filter((item) => item.lat !== undefined && item.lon !== undefined).length,
    sprites,
    items,
  };
  await writeJson(indexPath, index, true);
  await writeHashes(hashesPath, hashEntries);
  log.ok(`${config.id}: ${items.length} image records, ${sprites?.count ?? 0} sprites`);
  return {
    id: config.id,
    label: config.label,
    provider: config.provider,
    description: config.description,
    attribution: config.attribution,
    totalItems: items.length,
    coordsAvailable: index.coordsAvailable,
    coordinateSources,
    indexPath,
    spritesImagePath: sprites ? spritesImagePath : undefined,
    spritesJsonPath: sprites ? spritesJsonPath : undefined,
  };
}

/**
 * Human-readable report for the CI job summary / release notes: per collection,
 * how many manifests carry their own navPlace extension vs. how many rely on
 * paired coordinates in <Name>Collection.json, with the URL lists collapsed.
 */
function buildImageCollectionsMarkdown(results: ImageCollectionBuildResult[]): string {
  if (results.length === 0) return "_No image collections found._\n";
  const lines: string[] = [
    "| Collection | Items | navPlace | Paired coordinates |",
    "| --- | --- | --- | --- |",
  ];
  for (const result of results) {
    lines.push(`| ${result.label} (\`${result.id}\`) | ${result.totalItems} | ${result.coordinateSources.navPlace.length} | ${result.coordinateSources.paired.length} |`);
  }
  lines.push("");
  for (const result of results) {
    const { navPlace, paired } = result.coordinateSources;
    lines.push(`### ${result.label} (\`${result.id}\`)`);
    lines.push("");
    if (paired.length === 0) lines.push("✓ Every manifest carries the navPlace extension.");
    else if (navPlace.length === 0) lines.push(`No manifest carries the navPlace extension — all ${paired.length} rely on paired coordinates in \`${result.id}Collection.json\`.`);
    else lines.push(`${navPlace.length} manifest(s) carry the navPlace extension; ${paired.length} rely on paired coordinates in \`${result.id}Collection.json\`.`);
    lines.push("");
    for (const [title, urls] of [["Manifests with navPlace", navPlace], ["Manifests with paired coordinates", paired]] as const) {
      if (urls.length === 0) continue;
      lines.push(`<details><summary>${title} (${urls.length})</summary>`, "");
      for (const url of urls) lines.push(`- ${url}`);
      lines.push("", "</details>", "");
    }
  }
  return `${lines.join("\n")}\n`;
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
  const collections = await discoverImageCollections(options.selectedIds);
  if (collections.length === 0) {
    log.warn("no image collections found");
    await ensureDir(dirname(BUILD_IMAGE_COLLECTIONS_SUMMARY_PATH));
    await writeFile(BUILD_IMAGE_COLLECTIONS_SUMMARY_PATH, buildImageCollectionsMarkdown([]), "utf-8");
    return [];
  }
  const results: ImageCollectionBuildResult[] = [];
  for (const collection of collections) {
    const result = options.buildLog
      ? await options.buildLog.timed(`imagecollection:${collection.config.id}`, () => buildCollection(collection, options))
      : await buildCollection(collection, options);
    results.push(result);
    await options.buildLog?.section(`Image Collection: ${collection.config.id}`);
    await options.buildLog?.fields({
      items: result.totalItems,
      "with coordinates": result.coordsAvailable,
      "navPlace coordinates": result.coordinateSources.navPlace.length,
      "paired coordinates": result.coordinateSources.paired.length,
      index: result.indexPath,
      sprites: result.spritesImagePath,
    });
  }
  await publishImageCollectionYaml(results, options.force);
  await ensureDir(dirname(BUILD_IMAGE_COLLECTIONS_SUMMARY_PATH));
  await writeFile(BUILD_IMAGE_COLLECTIONS_SUMMARY_PATH, buildImageCollectionsMarkdown(results), "utf-8");
  await options.buildLog?.section("Image Collections Summary");
  await options.buildLog?.fields({
    collections: results.length,
    items: results.reduce((sum, result) => sum + result.totalItems, 0),
    "with coordinates": results.reduce((sum, result) => sum + result.coordsAvailable, 0),
    output: BUILD_IMAGE_COLLECTION_YAML_PATH,
  });
  return results;
}
