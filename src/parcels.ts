import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

type FeatureGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

type Feature = {
  type: "Feature";
  geometry: FeatureGeometry;
  properties?: Record<string, unknown>;
};

type FeatureCollection = {
  type: "FeatureCollection";
  features: Feature[];
};

// Mapping from source directory name to PascalCase map identifier
const MAP_ID_MAPPING: Record<string, string> = {
  Primitief: "PrimitiefKadaster",
  Primitive: "PrimitiefKadaster",  // Handle both spellings
};

async function consolidateParcelsForMap(mapSourceDir: string, mapId: string, outDir: string): Promise<number> {
  const consolidatedFeatures: Feature[] = [];

  // Read all individual parcel files from the map directory
  try {
    const entries = await readdir(mapSourceDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".geojson")) continue;
      if (entry.name === "index.geojson") continue;  // Skip the consolidated index file

      const filePath = join(mapSourceDir, entry.name);
      try {
        const content = await readFile(filePath, "utf-8");
        const geojson = JSON.parse(content) as FeatureCollection;

        if (geojson.type === "FeatureCollection" && Array.isArray(geojson.features)) {
          for (const feature of geojson.features) {
            // Only include Polygon features, skip MultiPolygon
            if (feature.type === "Feature" && feature.geometry?.type === "Polygon") {
              // Create minimal schema version with empty properties
              const minimalFeature: Feature = {
                type: "Feature",
                properties: { type: "parcel" },
                geometry: {
                  type: "Polygon",
                  coordinates: (feature.geometry as any).coordinates,
                },
              };
              consolidatedFeatures.push(minimalFeature);
            }
          }
        }
      } catch (error) {
        console.warn(`Warning: Failed to process parcel file ${filePath}`);
      }
    }
  } catch (error) {
    console.warn(`Warning: Failed to read parcel directory ${mapSourceDir}`);
    return 0;
  }

  if (consolidatedFeatures.length === 0) {
    console.log(`  No parcel features found for ${mapId}`);
    return 0;
  }

  // Write consolidated index file
  const mapDir = join(outDir, mapId);
  await mkdir(mapDir, { recursive: true });

  const consolidatedGeoJSON: FeatureCollection = {
    type: "FeatureCollection",
    features: consolidatedFeatures,
  };

  const indexPath = join(mapDir, "index.geojson");
  await writeFile(indexPath, JSON.stringify(consolidatedGeoJSON), "utf-8");

  console.log(`  Wrote ${indexPath} (${consolidatedFeatures.length} polygons)`);
  return consolidatedFeatures.length;
}

async function main() {
  const sourceRoot = "data/sources/Parcels";
  const buildRoot = "build/Parcels";
  const outDir = "build/Parcels";

  // First, try to consolidate from source data
  const sourceEntries = await readdir(sourceRoot, { withFileTypes: true });
  const sourceMaps = sourceEntries.filter((e) => e.isDirectory()).map((e) => e.name);

  console.log(`[1/2] Found ${sourceMaps.length} source directories under ${sourceRoot}`);
  console.log(`      Available: ${sourceMaps.join(", ")}`);

  // Check if we have existing parcel data to consolidate
  const existingEntries = await readdir(buildRoot, { withFileTypes: true });
  const existingMaps = existingEntries.filter((e) => e.isDirectory()).map((e) => e.name);

  console.log(`[1/2] Found ${existingMaps.length} existing parcel directories under ${buildRoot}`);

  // Determine which maps to process
  const mapsToProcess = new Map<string, string>();

  // Process existing parcel directories (like "Primitive")
  for (const existingMap of existingMaps) {
    const mapId = MAP_ID_MAPPING[existingMap];
    if (mapId) {
      mapsToProcess.set(existingMap, mapId);
    } else {
      console.warn(`Warning: Unknown parcel directory "${existingMap}", will attempt to map as-is`);
      mapsToProcess.set(existingMap, existingMap);
    }
  }

  // Backup old structure before reorganizing
  const backupDir = join(outDir, ".backup");
  if (mapsToProcess.size > 0) {
    await mkdir(backupDir, { recursive: true });
  }

  console.log(`[2/2] Consolidating parcel files into per-map GeoJSON...`);
  let totalPolygons = 0;

  for (const [sourceDir, mapId] of mapsToProcess) {
    const mapSourcePath = join(buildRoot, sourceDir);
    const count = await consolidateParcelsForMap(mapSourcePath, mapId, outDir);
    totalPolygons += count;
  }

  console.log(`Done. Consolidated ${totalPolygons} polygons across ${mapsToProcess.size} maps`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
