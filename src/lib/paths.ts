import { join } from "node:path";

/** Authoring inputs (config in git, raw geojson local). */
export const SOURCE_LAYERS_DIR = "Source/layers";

/** Published, per-layer output. */
export const BUILD_LAYERS_DIR = "build/Layers";

/** Scratch for intermediate NDJSON handed to tippecanoe. */
export const BUILD_TMP_DIR = "build/.tmp";

export const toponymsSrcDir = (layerId: string) => join(SOURCE_LAYERS_DIR, layerId, "toponyms");
export const parcelsSrcDir = (layerId: string) => join(SOURCE_LAYERS_DIR, layerId, "parcels");
export const layerOutDir = (layerId: string) => join(BUILD_LAYERS_DIR, layerId);
export const iiifCacheDir = (kind: "collections" | "manifests" | "info" | "sprites" | "warp") => join(".build-cache", "iiif", kind);
/** Per-layer scratch for a stage (e.g. warped GeoTIFFs + XYZ tiles for raster). */
export const layerTmpDir = (layerId: string, stage: string) => join(BUILD_TMP_DIR, layerId, stage);
export const allmapsCanvasCacheDir = () => join(".build-cache", "allmaps", "canvases");
