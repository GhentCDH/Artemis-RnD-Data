import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
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

      indexItems.push({
        id,
        text: textRaw,
        textNormalized: normalizeText(textRaw),
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

  console.log(`[2/2] Writing ${outIndex}`);
  await writeFile(outIndex, JSON.stringify(indexPayload), "utf-8");

  console.log(`Done. files=${files.length}, items=${indexItems.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
