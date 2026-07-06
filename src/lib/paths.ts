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

/** Non-georeferenced image collection build config. */
export const imageCollectionConfigPath = () => join(sourceDir(), "ImageCollectionConfig.yaml");

/** Logo registry: filename → click-through URL, resolved into build/layers.yaml. */
export const logosRegistryPath = () => join(sourceDir(), "attribution-logos", "logos.yaml");

/** Published build root. */
export const BUILD_DIR = "build";

/** Merged, published viewer layer config. */
export const BUILD_LAYERS_YAML_PATH = join(BUILD_DIR, "layers.yaml");

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
