/*
 * Raster warp/tile stage config. Defaults reuse the tuned values from the old
 * Python IIIF-Geotiff pipeline: low-res capped source fetch, 512px WEBP tiles,
 * zoom 8-12. Everything is env-overridable for one-off higher/lower detail runs.
 */

const DEFAULT_FETCH_WIDTH = 1024; // sprite 512 x fetch-scale 2 in the old pipeline
const DEFAULT_TILE_SIZE = 512;
const DEFAULT_TILE_FORMAT = "webp";
const DEFAULT_MIN_ZOOM = 8;
// z13 (~19 m/px) is the deepest level a 1024px fetch (~17.5 m/px warp) renders
// crisply; z14 would upscale ~1.8x, so raise RASTER_FETCH_WIDTH too before z14+.
const DEFAULT_MAX_ZOOM = 13;
const DEFAULT_WEBP_QUALITY = 75;

const VALID_TILE_FORMATS = new Set(["webp", "png", "jpeg"]);

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Long edge (px) of the capped IIIF image fetched as the warp source. */
export function rasterFetchWidth(): number {
  return intEnv("RASTER_FETCH_WIDTH", DEFAULT_FETCH_WIDTH);
}

export function rasterTileSize(): number {
  return intEnv("RASTER_TILE_SIZE", DEFAULT_TILE_SIZE);
}

/** gdal2tiles tile driver: webp (default, keeps transparency), png, or jpeg. */
export function rasterTileFormat(): "webp" | "png" | "jpeg" {
  const value = (process.env.RASTER_TILE_FORMAT ?? "").toLowerCase();
  return (VALID_TILE_FORMATS.has(value) ? value : DEFAULT_TILE_FORMAT) as "webp" | "png" | "jpeg";
}

export function rasterMinZoom(): number {
  return intEnv("RASTER_MIN_ZOOM", DEFAULT_MIN_ZOOM);
}

export function rasterMaxZoom(): number {
  const max = intEnv("RASTER_MAX_ZOOM", DEFAULT_MAX_ZOOM);
  return Math.max(max, rasterMinZoom());
}

export function rasterWebpQuality(): number {
  const quality = intEnv("RASTER_WEBP_QUALITY", DEFAULT_WEBP_QUALITY);
  return Math.min(100, Math.max(1, quality));
}

/**
 * Signature of every knob that affects the tiled raster or mask output. Folded
 * into the per-layer raster signature so config changes invalidate cached
 * raster.pmtiles/masks.pmtiles even when the georeference inputs are unchanged.
 */
export function rasterConfigSignature(vectorBuffer?: number): string {
  return [
    rasterFetchWidth(),
    rasterTileSize(),
    rasterTileFormat(),
    rasterMinZoom(),
    rasterMaxZoom(),
    rasterWebpQuality(),
    vectorBuffer ?? "",
  ].join(":");
}

/** gdal2tiles --tiledriver expects an uppercase driver name. */
export function gdal2tilesDriver(format: "webp" | "png" | "jpeg"): string {
  return { webp: "WEBP", png: "PNG", jpeg: "JPEG" }[format];
}

/** File extension gdal2tiles writes for a given tile format. */
export function tileExtension(format: "webp" | "png" | "jpeg"): string {
  return format === "jpeg" ? "jpg" : format;
}
