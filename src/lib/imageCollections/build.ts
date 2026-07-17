import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateId } from "@allmaps/id";
import sharp from "sharp";
import YAML from "yaml";
import type { BuildLog } from "../build/buildLog";
import { runPool } from "../concurrency";
import { canvasImageService, iiifLabel, infoJson, manifestCanvases } from "../iiif/manifests";
import { revalidatedJson, sha1 } from "../iiif/fetchCache";
import { calculateSpriteSize, fetchSprite, packSprites } from "../iiif/sprites";
import type { SpriteSource } from "../iiif/types";
import { log } from "../log";
import { localize, type LocalizedText } from "../localization";
import {
  BUILD_IMAGE_COLLECTION_YAML_PATH,
  BUILD_IMAGE_COLLECTIONS_SUMMARY_PATH,
  sourceImageCollectionsDir,
  imageCollectionCacheDir,
  imageCollectionOutDir,
} from "../paths";
import { ensureDir, fileExists, writeJson } from "../utils/files";
import { contentHash, stableStringify } from "../utils/hash";
import { extractManifestMetadata } from "./manifestMetadata";

const IMAGE_COLLECTION_RECIPE = 10;

type CollectionSource = { citation: string; url: string };

type ImageCollectionConfig = {
  id: string;
  label: LocalizedText;
  provider?: string;
  description?: LocalizedText;
  sources: CollectionSource[];
  furtherReading?: Record<string, string>;
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
  year?: string;
  date?: string;
  lat?: number;
  lon?: number;
  manifestUrl: string;
  recordId?: string;
  repId?: string;
  searchText: string;
};

type MetadataIssues = {
  missingYears: string[];
  ambiguousYears: Array<{ manifestUrl: string; years: string[] }>;
  missingIdentifiers: string[];
  duplicateIdentifiers: Array<{ identifier: string; manifestUrls: string[] }>;
};

export type ImageCollectionBuildResult = {
  id: string;
  label: LocalizedText;
  provider?: string;
  description?: LocalizedText;
  sources: CollectionSource[];
  furtherReading?: Record<string, string>;
  totalItems: number;
  coordsAvailable: number;
  /** Manifest URLs grouped by where their coordinates came from (navPlace extension vs paired data in <Name>Collection.json). */
  coordinateSources: { navPlace: string[]; paired: string[] };
  metadataIssues: MetadataIssues;
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
    const label = asRecord(parsed.label);
    const sources = Array.isArray(parsed.sources) ? parsed.sources.map(asRecord) : [];
    const furtherReading = parsed.furtherReading === undefined ? undefined : asRecord(parsed.furtherReading);
    if (!id || typeof label.en !== "string" || !label.en.trim() || typeof label.nl !== "string" || !label.nl.trim()) {
      throw new Error(`${path}: image collection config requires id and label with non-empty en and nl values`);
    }
    if (sources.length === 0 || sources.some((source) => typeof source.citation !== "string" || !source.citation.trim() || typeof source.url !== "string" || !/^https?:\/\//i.test(source.url))) {
      throw new Error(`${path}: image collection sources must contain non-empty citation and HTTP(S) url values`);
    }
    if (furtherReading && Object.entries(furtherReading).some(([label, url]) => !label.trim() || typeof url !== "string" || !/^https?:\/\//i.test(url))) {
      throw new Error(`${path}: furtherReading must map non-empty labels to HTTP(S) URLs`);
    }
    if (id !== dirName) throw new Error(`${path}: id "${id}" must match containing directory "${dirName}"`);
    return {
      id,
      label: { en: label.en, nl: label.nl },
      provider: typeof parsed.provider === "string" ? parsed.provider : undefined,
      description: (() => {
        if (parsed.description === undefined) return undefined;
        const description = asRecord(parsed.description);
        if (typeof description.en !== "string" || !description.en.trim() || typeof description.nl !== "string" || !description.nl.trim()) {
          throw new Error(`${path}: description must contain non-empty en and nl values`);
        }
        return { en: description.en, nl: description.nl };
      })(),
      sources: sources.map((source) => ({ citation: source.citation as string, url: source.url as string })),
      furtherReading: furtherReading as Record<string, string> | undefined,
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
  yearCandidates: string[];
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
    const metadata = extractManifestMetadata(manifest, entry.manifestUrl);
    const identifier = metadata.recordId ?? metadata.repId ?? metadata.manifestId;
    records[index] = {
      manifest,
      coordinateSource: entry.coordinates ? "paired" : "navPlace",
      yearCandidates: metadata.yearCandidates,
      item: {
        id: metadata.repId ?? await generateId(entry.manifestUrl),
        title,
        year: metadata.year,
        date: metadata.date,
        lat: roundCoordinate(coords.lat),
        lon: roundCoordinate(coords.lon),
        manifestUrl: entry.manifestUrl,
        recordId: metadata.recordId,
        repId: metadata.repId,
        searchText: [title, metadata.year, identifier, config.label.en, config.label.nl, config.provider].filter(Boolean).join(" "),
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

function metadataIssues(records: CollectionRecord[]): MetadataIssues {
  const byIdentifier = new Map<string, string[]>();
  const missingIdentifiers: string[] = [];
  for (const record of records) {
    const identifiers: Array<[string, string]> = [];
    if (record.item.recordId) identifiers.push(["recordId", record.item.recordId]);
    if (record.item.repId) identifiers.push(["repId", record.item.repId]);
    if (identifiers.length === 0) {
      missingIdentifiers.push(record.item.manifestUrl);
      continue;
    }
    for (const [kind, identifier] of identifiers) {
      const key = `${kind}: ${identifier}`;
      byIdentifier.set(key, [...(byIdentifier.get(key) ?? []), record.item.manifestUrl]);
    }
  }
  return {
    missingYears: records.filter((record) => !record.item.year).map((record) => record.item.manifestUrl),
    ambiguousYears: records
      .filter((record) => record.yearCandidates.length > 1)
      .map((record) => ({ manifestUrl: record.item.manifestUrl, years: record.yearCandidates })),
    missingIdentifiers,
    duplicateIdentifiers: [...byIdentifier]
      .filter(([, urls]) => urls.length > 1)
      .map(([identifier, manifestUrls]) => ({ identifier, manifestUrls })),
  };
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
  const issues = metadataIssues(records);
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
      sources: config.sources,
      furtherReading: config.furtherReading,
      totalItems: items.length,
      coordsAvailable: items.filter((item) => item.lat !== undefined && item.lon !== undefined).length,
      coordinateSources,
      metadataIssues: issues,
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
    sources: config.sources,
    furtherReading: config.furtherReading,
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
    sources: config.sources,
    furtherReading: config.furtherReading,
    totalItems: items.length,
    coordsAvailable: index.coordsAvailable,
    coordinateSources,
    metadataIssues: issues,
    indexPath,
    spritesImagePath: sprites ? spritesImagePath : undefined,
    spritesJsonPath: sprites ? spritesJsonPath : undefined,
  };
}

/**
 * Human-readable report for the CI job summary / release notes: coordinate
 * provenance plus year and identifier coverage, with URL lists collapsed.
 */
function buildImageCollectionsMarkdown(results: ImageCollectionBuildResult[]): string {
  if (results.length === 0) return "_No image collections found._\n";
  const lines: string[] = [
    "| Collection | Items | Years | navPlace | Paired coordinates | Identifier issues |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const identifierIssueCount = result.metadataIssues.missingIdentifiers.length + result.metadataIssues.duplicateIdentifiers.length;
    const label = `${localize(result.label, "nl")} / ${localize(result.label, "en")}`;
    lines.push(`| ${label} (\`${result.id}\`) | ${result.totalItems} | ${result.totalItems - result.metadataIssues.missingYears.length}/${result.totalItems} | ${result.coordinateSources.navPlace.length} | ${result.coordinateSources.paired.length} | ${identifierIssueCount} |`);
  }
  lines.push("");
  for (const result of results) {
    const { navPlace, paired } = result.coordinateSources;
    lines.push(`### ${localize(result.label, "nl")} / ${localize(result.label, "en")} (\`${result.id}\`)`);
    lines.push("");
    if (paired.length === 0) lines.push("✓ Every manifest carries the navPlace extension.");
    else if (navPlace.length === 0) lines.push(`No manifest carries the navPlace extension — all ${paired.length} rely on paired coordinates in \`${result.id}Collection.json\`.`);
    else lines.push(`${navPlace.length} manifest(s) carry the navPlace extension; ${paired.length} rely on paired coordinates in \`${result.id}Collection.json\`.`);
    lines.push("");
    const issueGroups: Array<[string, string[]]> = [
      ["Manifests without a year", result.metadataIssues.missingYears],
      ["Manifests without an identifier", result.metadataIssues.missingIdentifiers],
      ["Manifests with ambiguous years", result.metadataIssues.ambiguousYears.map((issue) => `${issue.manifestUrl} — ${issue.years.join(", ")}`)],
      ["Duplicate identifiers", result.metadataIssues.duplicateIdentifiers.map((issue) => `${issue.identifier} — ${issue.manifestUrls.join(", ")}`)],
    ];
    if (issueGroups.every(([, entries]) => entries.length === 0)) {
      lines.push("✓ Every manifest has one year and a unique identifier.", "");
    } else {
      for (const [title, entries] of issueGroups) {
        if (entries.length === 0) continue;
        lines.push(`<details><summary>⚠ ${title} (${entries.length})</summary>`, "");
        for (const entry of entries) lines.push(`- ${entry}`);
        lines.push("", "</details>", "");
      }
    }
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
    sources: result.sources,
    furtherReading: result.furtherReading,
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
      "with year": result.totalItems - result.metadataIssues.missingYears.length,
      "missing identifiers": result.metadataIssues.missingIdentifiers.length,
      "duplicate identifiers": result.metadataIssues.duplicateIdentifiers.length,
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
