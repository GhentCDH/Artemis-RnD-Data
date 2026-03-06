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
  rawText: string;
  placeName?: string;
  textNormalized: string;
  sourceGroup: string;
  sourceFile: string;
  mapId: string;
  mapName: string;
  featureIndex: number;
  lon: number;
  lat: number;
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
  const outIndex = join(outDir, "index.json");

  const files = await listSourceFiles(sourceRoot);
  console.log(`[1/2] Found ${files.length} source files under ${sourceRoot}`);
  if (files.length < 1) {
    throw new Error(
      `No toponym source files found under ${sourceRoot}. Refusing to overwrite existing ${outIndex}.`
    );
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const indexItems: IndexItem[] = [];
  const sourceSummary = new Map<string, { fileCount: number; featureCount: number }>();

  for (const file of files) {
    const json = JSON.parse(await readFile(file, "utf-8")) as SourceFeatureCollection;
    const features = Array.isArray(json.features) ? json.features : [];
    const sourceGroup = basename(relative(sourceRoot, file).split("/")[0] ?? "");
    const sourceFile = relative(sourceRoot, file).replace(/\\/g, "/");
    const mapId = sourceGroup.toLowerCase();
    const mapName = sourceGroup;
    const placeName = placeNameFromSourceFile(sourceFile);

    if (!sourceSummary.has(sourceGroup)) {
      sourceSummary.set(sourceGroup, { fileCount: 0, featureCount: 0 });
    }
    sourceSummary.get(sourceGroup)!.fileCount += 1;

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
      const displayText = placeName ? `${placeName} - ${textRaw}` : textRaw;

      indexItems.push({
        id,
        text: displayText,
        rawText: textRaw,
        ...(placeName ? { placeName } : {}),
        textNormalized: normalizeText(displayText),
        sourceGroup,
        sourceFile,
        mapId,
        mapName,
        featureIndex,
        lon,
        lat,
      });

      sourceSummary.get(sourceGroup)!.featureCount += 1;
    });
  }

  indexItems.sort((a, b) => {
    const textCmp = a.text.localeCompare(b.text);
    if (textCmp !== 0) return textCmp;
    const sourceCmp = a.sourceFile.localeCompare(b.sourceFile);
    if (sourceCmp !== 0) return sourceCmp;
    return a.featureIndex - b.featureIndex;
  });

  const indexPayload = {
    generatedAt: new Date().toISOString(),
    sourceRoot,
    sourceFileCount: files.length,
    itemCount: indexItems.length,
    sourceGroups: [...sourceSummary.entries()]
      .map(([sourceGroup, stats]) => ({ sourceGroup, ...stats }))
      .sort((a, b) => a.sourceGroup.localeCompare(b.sourceGroup)),
    items: indexItems,
  };
  if (indexItems.length < 1) {
    throw new Error(`Toponym source files were found but produced 0 index items. Refusing to write ${outIndex}.`);
  }

  console.log(`[2/2] Writing ${outIndex}`);
  await writeFile(outIndex, JSON.stringify(indexPayload, null, 2), "utf-8");

  console.log(`Done. files=${files.length}, items=${indexItems.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
