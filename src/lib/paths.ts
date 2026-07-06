import { join } from "node:path";

/** Authoring source root (config in git, raw geojson local). */
export const SOURCE_DIR = "Source";

/** Authoring inputs (config in git, raw geojson local). */
export const SOURCE_LAYERS_DIR = join(SOURCE_DIR, "layers");

/** Logo registry: filename → click-through URL, resolved into build/layers.yaml. */
export const LOGOS_REGISTRY_PATH = join(SOURCE_DIR, "attribution-logos", "logos.yaml");

/** Published build root. */
export const BUILD_DIR = "build";

/** Merged, published viewer layer config. */
export const BUILD_LAYERS_YAML_PATH = join(BUILD_DIR, "layers.yaml");

/** Published, per-layer output. */
export const BUILD_LAYERS_DIR = join(BUILD_DIR, "Layers");

/** Scratch for intermediate NDJSON handed to tippecanoe. */
export const BUILD_TMP_DIR = "build/.tmp";

/** Private build cache (fetch cache + warp accelerators); never deployed. */
export const BUILD_CACHE_DIR = ".build-cache";

/** Persistent per-canvas warped GeoTIFF cache, keyed by warp signature. */
export const warpTifCacheDir = (layerId: string) => join(BUILD_CACHE_DIR, "warp-tif", layerId);

/** Committed per-layer source→data-hash registry (change-detection state, portable to CI). */
export const layerHashesPath = (layerId: string) => join(layerOutDir(layerId), "hashes.txt");

export const toponymsSrcDir = (layerId: string) => join(SOURCE_LAYERS_DIR, layerId, "toponyms");
export const parcelsSrcDir = (layerId: string) => join(SOURCE_LAYERS_DIR, layerId, "parcels");
export const layerOutDir = (layerId: string) => join(BUILD_LAYERS_DIR, layerId);
export const iiifCacheDir = (kind: "collections" | "manifests" | "info" | "sprites" | "warp") => join(".build-cache", "iiif", kind);
/** Per-layer scratch for a stage (e.g. warped GeoTIFFs + XYZ tiles for raster). */
export const layerTmpDir = (layerId: string, stage: string) => join(BUILD_TMP_DIR, layerId, stage);
export const allmapsCanvasCacheDir = () => join(".build-cache", "allmaps", "canvases");
