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

/** Logo image assets + their registry (filename -> click-through URL). */
export const sourceAttributionLogosDir = () => join(sourceDir(), "attribution-logos");
export const logosRegistryPath = () => join(sourceAttributionLogosDir(), "logos.yaml");

/** Site-level "about" config (title, blurb, team, project-level logos). */
export const aboutJsonPath = () => join(sourceDir(), "about.json");

/** Site-wide reference boundary layer (not tied to any single historical map layer). */
export const sourceBaselayerPath = () => join(sourceDir(), "Baselayer.geojson");

/** Published build root. */
export const BUILD_DIR = "build";

/** Merged, published viewer layer config. */
export const BUILD_LAYERS_YAML_PATH = join(BUILD_DIR, "layers.yaml");

/** Published "about" config, logos resolved the same way as sublayer attribution. */
export const BUILD_ABOUT_JSON_PATH = join(BUILD_DIR, "about.json");

/** Published logo image assets - deploy-relative paths in resolved logo objects point here. */
export const BUILD_ATTRIBUTION_LOGOS_DIR = join(BUILD_DIR, "attribution-logos");

/** Published site-wide reference boundary layer. */
export const BUILD_BASELAYER_PMTILES_PATH = join(BUILD_DIR, "baselayer.pmtiles");

/** Human-readable Markdown table of every sublayer + kind, for the CI job summary / release notes. */
export const BUILD_SUBLAYERS_SUMMARY_PATH = join(BUILD_DIR, "Sublayers.md");

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
