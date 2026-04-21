import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { simplifyPolygonDouglasPeucker } from "./simplify";

// Geographic Douglas-Peucker epsilon for parcel simplification (degrees WGS84, ~1.5 m in Belgium).
// Override via PARCEL_SIMPLIFY_EPSILON env var.
const PARCEL_GEO_EPSILON = process.env.PARCEL_SIMPLIFY_EPSILON
  ? parseFloat(process.env.PARCEL_SIMPLIFY_EPSILON)
  : 0.000015;

const MAP_ID_MAPPING: Record<string, string> = {
  Primitief: "PrimitiefKadaster",
  Primitive: "PrimitiefKadaster",
};

async function consolidateParcelsForMap(sourceDir: string, mapId: string, outDir: string): Promise<number> {
  const features: Array<{ type: "Feature"; properties: { type: "parcel" }; geometry: { type: "Polygon"; coordinates: number[][][] } }> = [];

  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".geojson")) continue;
    try {
      const geojson = JSON.parse(await readFile(join(sourceDir, entry.name), "utf-8"));
      if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) continue;

      for (const feature of geojson.features) {
        if (
          feature.type !== "Feature" ||
          feature.properties?.type !== "parcel" ||
          feature.geometry?.type !== "Polygon"
        ) continue;

        const rings = (feature.geometry.coordinates as number[][][]).map((ring) => {
          const pts = ring as Array<[number, number]>;
          const simplified = simplifyPolygonDouglasPeucker(pts, PARCEL_GEO_EPSILON);
          return simplified.length >= 3 ? simplified : pts;
        });

        features.push({
          type: "Feature",
          properties: { type: "parcel" },
          geometry: { type: "Polygon", coordinates: rings },
        });
      }
    } catch {
      console.warn(`Warning: failed to process ${entry.name}`);
    }
  }

  if (features.length === 0) {
    console.log(`  No parcel features found for ${mapId}`);
    return 0;
  }

  const mapDir = join(outDir, mapId);
  await mkdir(mapDir, { recursive: true });
  const outPath = join(mapDir, `${mapId}Parcels.geojson`);
  await writeFile(outPath, JSON.stringify({ type: "FeatureCollection", features }), "utf-8");
  console.log(`  Wrote ${outPath} (${features.length} polygons, epsilon=${PARCEL_GEO_EPSILON})`);
  return features.length;
}

async function main() {
  const sourceRoot = "data/sources/Parcels";
  const outDir = "build/Parcels";

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const sourceDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);

  console.log(`Found ${sourceDirs.length} source directories: ${sourceDirs.join(", ")}`);

  let total = 0;
  for (const sourceDir of sourceDirs) {
    const mapId = MAP_ID_MAPPING[sourceDir] ?? sourceDir;
    total += await consolidateParcelsForMap(join(sourceRoot, sourceDir), mapId, outDir);
  }

  console.log(`Done. ${total} polygons across ${sourceDirs.length} maps`);
}

main().catch((e) => { console.error(e); process.exit(1); });
