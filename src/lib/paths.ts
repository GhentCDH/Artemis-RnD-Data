import { join } from "node:path";

/** Authoring source root (config in git, raw geojson local). */
let sourceDirValue = process.env.ARTEMIS_SOURCE_DIR ?? process.env.SOURCE_DIR ?? "Source";

export function setSourceDir(path: string): void {
  sourceDirValue = path;
}

export function sourceDir(): string {
  return sourceDirValue;
}

/** Authoring source root (config in git, raw geojson local). */
export const SOURCE_DIR = sourceDirValue;

/** Authoring inputs (config in git, raw geojson local). */
export const SOURCE_LAYERS_DIR = join(SOURCE_DIR, "layers");

export const sourceLayersDir = () => join(sourceDir(), "layers");

/** Non-georeferenced image collection source configs (one directory per collection, like layers/). */
export const sourceImageCollectionsDir = () => join(sourceDir(), "imagecollections");

/** Site-wide default background maps and overlays. */
export const mapServicesYamlPath = () => join(sourceDir(), "map-services.yaml");

/** Site-wide reference layers (not tied to any single historical map layer). */
export const sourceBaselayerWaterPath = () => join(sourceDir(), "Baselayer_Water.pmtiles");
export const sourceBaselayerBorderPath = () => join(sourceDir(), "Baselayer_Border.geojson");

/** Published build root. */
export const BUILD_DIR = "build";

/** Merged, published viewer layer config. */
export const BUILD_LAYERS_YAML_PATH = join(BUILD_DIR, "layers.yaml");

/** Published site-wide default background maps and overlays. */
export const BUILD_MAP_SERVICES_YAML_PATH = join(BUILD_DIR, "map-services.yaml");

/** Published site-wide baselayer archives. */
export const BUILD_BASELAYER_WATER_PMTILES_PATH = join(BUILD_DIR, "baselayer-water.pmtiles");
export const BUILD_BASELAYER_BORDER_PMTILES_PATH = join(BUILD_DIR, "baselayer-border.pmtiles");
/** Retired combined archive, removed by the baselayer build for clean local builds. */
export const RETIRED_BUILD_BASELAYER_PMTILES_PATH = join(BUILD_DIR, "baselayer.pmtiles");

/** Human-readable Markdown table of every sublayer + kind, for the CI job summary / release notes. */
export const BUILD_SUBLAYERS_SUMMARY_PATH = join(BUILD_DIR, "Sublayers.md");

/** Human-readable Markdown report of every image collection (navPlace vs paired coordinates), for the CI job summary / release notes. */
export const BUILD_IMAGE_COLLECTIONS_SUMMARY_PATH = join(BUILD_DIR, "ImageCollections.md");

/** Which Zenodo record this build synced from and whether it was a draft - read by CI to route the output branch/release. */
export const BUILD_ZENODO_SOURCE_PATH = join(BUILD_DIR, "ZenodoSource.json");

/** Published, per-layer output. */
export const BUILD_LAYERS_DIR = join(BUILD_DIR, "Layers");

/** Published, non-georeferenced image collection output. */
export const BUILD_IMAGE_COLLECTIONS_DIR = join(BUILD_DIR, "Image collections");

/** Published image collection registry. */
export const BUILD_IMAGE_COLLECTION_YAML_PATH = join(BUILD_DIR, "imagecollection.yaml");

/** Scratch for intermediate NDJSON handed to tippecanoe. */
export const BUILD_TMP_DIR = "build/.tmp";

/** Private build cache (fetch cache + warp accelerators); never deployed. */
export const BUILD_CACHE_DIR = ".build-cache";

/** Persistent per-canvas warped GeoTIFF cache, keyed by warp signature. */
export const warpTifCacheDir = (layerId: string) => join(BUILD_CACHE_DIR, "warp-tif", layerId);

/** Committed per-layer source→data-hash registry (change-detection state, portable to CI). */
export const layerHashesPath = (layerId: string) => join(layerOutDir(layerId), "hashes.txt");

export const toponymsSrcDir = (layerId: string) => join(sourceLayersDir(), layerId, "toponyms");
export const parcelsSrcDir = (layerId: string) => join(sourceLayersDir(), layerId, "parcels");
export const layerOutDir = (layerId: string) => join(BUILD_LAYERS_DIR, layerId);
export const imageCollectionOutDir = (collectionId: string) => join(BUILD_IMAGE_COLLECTIONS_DIR, collectionId);
export const iiifCacheDir = (kind: "collections" | "manifests" | "info" | "sprites" | "warp") => join(".build-cache", "iiif", kind);
export const imageCollectionCacheDir = (kind: "api" | "manifests" | "sprites") => join(".build-cache", "image-collections", kind);
/** Per-layer scratch for a stage (e.g. warped GeoTIFFs + XYZ tiles for raster). */
export const layerTmpDir = (layerId: string, stage: string) => join(BUILD_TMP_DIR, layerId, stage);
export const allmapsCanvasCacheDir = () => join(".build-cache", "allmaps", "canvases");
