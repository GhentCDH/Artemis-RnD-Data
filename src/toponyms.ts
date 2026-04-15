import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { createHash } from "node:crypto";

type Position = [number, number];
type Ring = Position[];
type PolygonCoordinates = Ring[];
type MultiPolygonCoordinates = PolygonCoordinates[];

type GeoGeometry =
  | { type: "Polygon"; coordinates: PolygonCoordinates }
  | { type: "MultiPolygon"; coordinates: MultiPolygonCoordinates };

type SourceFeature = {
  type: "Feature";
  geometry: GeoGeometry;
  properties?: Record<string, unknown>;
};

type SourceFeatureCollection = {
  type: "FeatureCollection";
  features?: SourceFeature[];
};

type IndexItem = {
  id: string;
  text: string;
  lon: number;
  lat: number;
  map: string;
  sheet?: string;
};

type PerMapOutput = {
  generatedAt: string;
  map: string;
  mapLabel: string;
  itemCount: number;
  items: IndexItem[];
};

// Mapping from source directory name to PascalCase map identifier and display label
const MAP_ID_MAPPING: Record<string, { id: string; label: string }> = {
  Ferraris: { id: "Ferraris", label: "Ferraris" },
  Primitief: { id: "PrimitiefKadaster", label: "Primitief Kadaster" },
  Gereduceerd: { id: "GereduceerdeKadaster", label: "Gereduceerde Kadaster" },
};

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function placeNameFromSourceFile(sourceFile: string): string | undefined {
  const fileBase = basename(sourceFile, extname(sourceFile));
  const m = fileBase.match(/^([A-Za-zÀ-ÖØ-öø-ÿ' -]+)_\d/);
  if (!m) return undefined;
  const place = m[1]?.trim();
  return place && place.length > 0 ? place : undefined;
}

function deriveSheetFromSourceFile(sourceFile: string): string | undefined {
  const fileBase = basename(sourceFile, extname(sourceFile));
  // Try to extract sheet number from filename patterns
  // Examples: "Aalst_59_a_33489_21941_16.geojson" -> "59"
  // "Aertselaer_1851.geojson" -> "1851"
  const parts = fileBase.split("_");
  if (parts.length >= 2) {
    // Return the second part if it looks like a number or identifier
    const potential = parts[1];
    if (potential && /^\d+/.test(potential)) {
      return potential;
    }
  }
  return undefined;
}

function getPositions(geometry: GeoGeometry): Position[] {
  if (geometry.type === "Polygon") {
    return geometry.coordinates.flat();
  }
  return geometry.coordinates.flat(2);
}

function computeBounds(positions: Position[]): [number, number, number, number] {
  if (positions.length === 0) {
    throw new Error("Cannot compute bounds for empty geometry.");
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of positions) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    throw new Error("Failed to compute valid bounds.");
  }

  return [minX, minY, maxX, maxY];
}

function centroidFromBounds([minX, minY, maxX, maxY]: [number, number, number, number]): Position {
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

async function listSourceFiles(rootDir: string): Promise<string[]> {
  const sourceDirs = (await readdir(rootDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const files: string[] = [];
  for (const sourceDir of sourceDirs) {
    const absSourceDir = join(rootDir, sourceDir);
    const entries = await readdir(absSourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(geojson|json)$/i.test(entry.name)) continue;
      files.push(join(absSourceDir, entry.name));
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

async function main() {
  const sourceRoot = "data/sources/Toponyms";
  const outDir = "build/Toponyms";

  const files = await listSourceFiles(sourceRoot);
  console.log(`[1/3] Found ${files.length} source files under ${sourceRoot}`);
  if (files.length < 1) {
    throw new Error(
      `No toponym source files found under ${sourceRoot}. Refusing to proceed.`
    );
  }

  // Remove old output directory
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Group items by map
  const itemsByMap = new Map<string, IndexItem[]>();
  const mapStats = new Map<string, { fileCount: number; featureCount: number }>();

  for (const file of files) {
    let json: SourceFeatureCollection;
    try {
      const content = await readFile(file, "utf-8");
      json = JSON.parse(content) as SourceFeatureCollection;
    } catch (error) {
      console.warn(`Warning: Failed to parse ${file}, skipping`);
      continue;
    }

    const features = Array.isArray(json.features) ? json.features : [];
    const sourceDir = basename(relative(sourceRoot, file).split("/")[0] ?? "");
    const sourceFile = relative(sourceRoot, file).replace(/\\/g, "/");
    const placeName = placeNameFromSourceFile(sourceFile);
    const sheet = deriveSheetFromSourceFile(sourceFile);

    const mapInfo = MAP_ID_MAPPING[sourceDir];
    if (!mapInfo) {
      console.warn(`Warning: Unknown source directory "${sourceDir}", skipping`);
      continue;
    }

    const mapId = mapInfo.id;
    if (!itemsByMap.has(mapId)) {
      itemsByMap.set(mapId, []);
      mapStats.set(mapId, { fileCount: 0, featureCount: 0 });
    }

    const stats = mapStats.get(mapId)!;
    stats.fileCount += 1;

    const items = itemsByMap.get(mapId)!;

    features.forEach((feature, featureIndex) => {
      if (!feature || feature.type !== "Feature" || !feature.geometry) return;
      if (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon") return;

      const textRaw = String(feature.properties?.text ?? "").trim();
      if (!textRaw) return;

      const positions = getPositions(feature.geometry);
      if (positions.length === 0) return;

      const bounds = computeBounds(positions);
      const [lon, lat] = centroidFromBounds(bounds);

      const idSeed = `${sourceFile}:${featureIndex}:${textRaw}`;
      const id = sha1(idSeed).slice(0, 16);

      items.push({
        id,
        text: textRaw,
        lon,
        lat,
        map: mapId,
        ...(sheet ? { sheet } : {}),
      });

      stats.featureCount += 1;
    });
  }

  // Write per-map files
  console.log(`[2/3] Writing per-map index files for ${itemsByMap.size} maps`);
  for (const [mapId, items] of itemsByMap) {
    const mapInfo = MAP_ID_MAPPING[Object.keys(MAP_ID_MAPPING).find(key => MAP_ID_MAPPING[key].id === mapId)!];
    if (!mapInfo) continue;

    // Sort items by text
    items.sort((a, b) => a.text.localeCompare(b.text));

    const mapDir = join(outDir, mapId);
    await mkdir(mapDir, { recursive: true });

    const output: PerMapOutput = {
      generatedAt: new Date().toISOString(),
      map: mapId,
      mapLabel: mapInfo.label,
      itemCount: items.length,
      items,
    };

    const mapIndexPath = join(mapDir, "index.json");
    await writeFile(mapIndexPath, JSON.stringify(output, null, 2), "utf-8");
    console.log(`  Wrote ${mapIndexPath} (${items.length} items)`);
  }

  // Report summary
  console.log(`[3/3] Summary`);
  let totalItems = 0;
  for (const [mapId, items] of itemsByMap) {
    const stats = mapStats.get(mapId)!;
    console.log(`  ${mapId}: ${items.length} items from ${stats.fileCount} files`);
    totalItems += items.length;
  }
  console.log(`Total: ${totalItems} items across ${itemsByMap.size} maps`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
