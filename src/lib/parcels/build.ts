import { join } from "node:path";
import type { Feature, FeatureCollection, PolygonGeometry, Position } from "../geojson/types";
import { isPolygonGeometry } from "../geojson/geometry";
import { simplifyRing, simplifyRingByReference } from "../geojson/simplify";
import type { LayerRef } from "../layers/discovery";
import { buildVectorPmtiles } from "../pmtiles/vector";
import { BUILD_TMP_DIR, layerOutDir, parcelsSrcDir } from "../paths";
import { runPool } from "../concurrency";
import { ensureDir, listFiles, readJsonFile, writeJson } from "../utils/files";
import { log } from "../log";
import type { BuildLog } from "../build/buildLog";

export type BuildParcelsOptions = {
  layers: LayerRef[];
  concurrency: number;
  writeGeojson?: boolean;
  buildLog?: BuildLog;
};

export type ParcelBuildResult = {
  layerId: string;
  sublayerId?: string;
  sourceFiles: number;
  features: number;
  simplification: ParcelSimplificationStats;
  geojsonPath?: string;
  pmtilesPath?: string;
};

export type ParcelSimplificationStats = {
  epsilon: number;
  featuresSimplified: number;
  ringsSimplified: number;
  inputPoints: number;
  outputPoints: number;
  removedPoints: number;
  pixelReferenceRings: number;
  coordinateReferenceRings: number;
};

const DEFAULT_PARCEL_EPSILON = 5;

function parcelSublayer(layer: LayerRef): { id: string; rawInput?: string } | undefined {
  const sublayer = layer.config.sublayers?.find((item) =>
    item.source?.rawInput?.startsWith("parcels/") ||
    item.id.toLowerCase().includes("parcel") ||
    item.name?.toLowerCase().includes("parcel")
  );
  return sublayer ? { id: sublayer.id, rawInput: sublayer.source?.rawInput } : undefined;
}

function parcelEpsilon(): number {
  const raw = process.env.PARCEL_SIMPLIFY_EPSILON;
  if (!raw) return DEFAULT_PARCEL_EPSILON;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PARCEL_EPSILON;
}

function emptySimplificationStats(): ParcelSimplificationStats {
  return {
    epsilon: parcelEpsilon(),
    featuresSimplified: 0,
    ringsSimplified: 0,
    inputPoints: 0,
    outputPoints: 0,
    removedPoints: 0,
    pixelReferenceRings: 0,
    coordinateReferenceRings: 0,
  };
}

function mergeStats(target: ParcelSimplificationStats, source: ParcelSimplificationStats): void {
  target.featuresSimplified += source.featuresSimplified;
  target.ringsSimplified += source.ringsSimplified;
  target.inputPoints += source.inputPoints;
  target.outputPoints += source.outputPoints;
  target.removedPoints += source.removedPoints;
  target.pixelReferenceRings += source.pixelReferenceRings;
  target.coordinateReferenceRings += source.coordinateReferenceRings;
}

function pixelGeometry(feature: Feature): PolygonGeometry | null {
  const value = feature.properties?.pixel_geometry;
  return isPolygonGeometry(value) ? value : null;
}

function simplifyParcelCoordinates(
  feature: Feature,
  geometry: PolygonGeometry,
  stats: ParcelSimplificationStats,
): PolygonGeometry["coordinates"] {
  const epsilon = parcelEpsilon();
  const pixel = pixelGeometry(feature);
  let featureRemovedPoints = 0;

  const coordinates = geometry.coordinates.map((ring, ringIndex) => {
    const referenceRing = pixel?.coordinates[ringIndex] as Position[] | undefined;
    const simplified = referenceRing
      ? simplifyRingByReference(ring, referenceRing, epsilon)
      : simplifyRing(ring, epsilon);
    const output = simplified.length >= 4 ? simplified : ring;
    const removed = Math.max(0, ring.length - output.length);

    stats.inputPoints += ring.length;
    stats.outputPoints += output.length;
    stats.removedPoints += removed;
    if (removed > 0) {
      stats.ringsSimplified += 1;
      featureRemovedPoints += removed;
    }
    if (referenceRing) stats.pixelReferenceRings += 1;
    else stats.coordinateReferenceRings += 1;

    return output;
  });

  if (featureRemovedPoints > 0) stats.featuresSimplified += 1;
  return coordinates;
}

function normalizeParcelFeature(
  feature: Feature,
  sourceFile: string,
  featureIndex: number,
  stats: ParcelSimplificationStats,
): Feature<Record<string, unknown>, PolygonGeometry> | null {
  if (feature.type !== "Feature" || !isPolygonGeometry(feature.geometry)) return null;
  if (feature.properties?.type !== "parcel") return null;

  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: simplifyParcelCoordinates(feature, feature.geometry, stats) },
    properties: {
      type: "parcel",
      sourceFile,
      sourceFeature: featureIndex,
      ...(typeof feature.properties.parcel_number === "string" ? { parcel_number: feature.properties.parcel_number } : {}),
      ...(typeof feature.properties.parcel_index === "number" ? { parcel_index: feature.properties.parcel_index } : {}),
    },
  };
}

async function buildLayerParcels(layer: LayerRef, options: BuildParcelsOptions): Promise<ParcelBuildResult> {
  const sublayer = parcelSublayer(layer);
  const sourceDir = parcelsSrcDir(layer.id);
  const files = await listFiles(sourceDir, /\.geojson$/i);
  if (files.length === 0) return { layerId: layer.id, sublayerId: sublayer?.id, sourceFiles: 0, features: 0, simplification: emptySimplificationStats() };

  const features: Array<Feature<Record<string, unknown>, PolygonGeometry>> = [];
  const simplification = emptySimplificationStats();
  await runPool(files, options.concurrency, async (file) => {
    const geojson = await readJsonFile<FeatureCollection>(file);
    if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
      throw new Error(`${file} is not a FeatureCollection`);
    }

    const sourceFile = file.slice(sourceDir.length + 1).replace(/\\/g, "/");
    const fileStats = emptySimplificationStats();
    geojson.features.forEach((feature, index) => {
      const parcel = normalizeParcelFeature(feature, sourceFile, index, fileStats);
      if (parcel) features.push(parcel);
    });
    mergeStats(simplification, fileStats);
  });

  const outDir = layerOutDir(layer.id);
  const featureCollection: FeatureCollection<Record<string, unknown>, PolygonGeometry> = {
    type: "FeatureCollection",
    features,
  };
  const tmpGeojsonPath = join(BUILD_TMP_DIR, layer.id, "parcels.geojson");
  const pmtilesPath = join(outDir, "parcels.pmtiles");

  await ensureDir(outDir);
  await writeJson(tmpGeojsonPath, featureCollection);
  await buildVectorPmtiles({
    inputGeojson: tmpGeojsonPath,
    outputPmtiles: pmtilesPath,
    tmpDir: join(BUILD_TMP_DIR, layer.id),
    layerName: "parcels",
    minZoom: 10,
    maxZoom: 15,
  });

  let geojsonPath: string | undefined;
  if (options.writeGeojson) {
    geojsonPath = join(outDir, "parcels.geojson");
    await writeJson(geojsonPath, featureCollection);
  }

  log.ok(`${layer.id}: ${features.length} parcels from ${files.length} files`);
  await options.buildLog?.section(`Parcels: ${sublayer?.id ?? layer.id}`);
  await options.buildLog?.fields({
    layer: layer.id,
    sublayer: sublayer?.id,
    source: sublayer?.rawInput ?? "parcels/*.geojson",
    "source files": files.length,
    polygons: features.length,
    output: pmtilesPath,
  });
  await options.buildLog?.section(`Douglas-Peucker: ${sublayer?.id ?? layer.id}`);
  await options.buildLog?.fields({
    layer: layer.id,
    sublayer: sublayer?.id,
    epsilon: simplification.epsilon,
    "input points": simplification.inputPoints,
    "output points": simplification.outputPoints,
    "removed points": simplification.removedPoints,
    "rings simplified": simplification.ringsSimplified,
    "features simplified": simplification.featuresSimplified,
    "pixel reference rings": simplification.pixelReferenceRings,
    "coordinate reference rings": simplification.coordinateReferenceRings,
  });
  return { layerId: layer.id, sublayerId: sublayer?.id, sourceFiles: files.length, features: features.length, simplification, geojsonPath, pmtilesPath };
}

export async function buildParcels(options: BuildParcelsOptions): Promise<ParcelBuildResult[]> {
  const results: ParcelBuildResult[] = [];
  for (const layer of options.layers.filter((item) => parcelSublayer(item))) {
    const result = options.buildLog
      ? await options.buildLog.timed(`parcels:${parcelSublayer(layer)?.id ?? layer.id}`, () => buildLayerParcels(layer, options))
      : await buildLayerParcels(layer, options);
    if (result.sourceFiles > 0) results.push(result);
  }

  const totalFeatures = results.reduce((sum, result) => sum + result.features, 0);
  const totalRemovedPoints = results.reduce((sum, result) => sum + result.simplification.removedPoints, 0);
  const totalInputPoints = results.reduce((sum, result) => sum + result.simplification.inputPoints, 0);
  const totalOutputPoints = results.reduce((sum, result) => sum + result.simplification.outputPoints, 0);
  log.ok(`parcels total: ${totalFeatures} polygons across ${results.length} layers`);
  await options.buildLog?.section("Parcels Summary");
  await options.buildLog?.fields({
    layers: results.length,
    polygons: totalFeatures,
    "input points": totalInputPoints,
    "output points": totalOutputPoints,
    "removed points": totalRemovedPoints,
  });
  return results;
}
