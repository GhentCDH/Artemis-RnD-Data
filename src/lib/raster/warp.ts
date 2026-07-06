import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { ensureDir, fileExists } from "../utils/files";
import { contentHash } from "../utils/hash";
import { runCommand } from "../utils/run";
import { rasterFetchWidth } from "./config";
import { fetchWarpSource, warpSourceCachePath } from "./fetch";

/**
 * Bump when the warp algorithm/output changes (gdalwarp args, cutline logic,
 * fetch strategy) so cached GeoTIFFs from an older recipe are invalidated even
 * when the georeference inputs are unchanged.
 */
const WARP_RECIPE = 1;

function round(value: unknown, decimals: number): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

/**
 * Canonical GCP tuples: `[resX, resY, lon, lat]` rounded well below output
 * resolution and sorted. GCP order does not affect the warp, and re-fetched
 * annotations carry insignificant float/ordering noise — canonicalizing here
 * keeps the signature stable so an unchanged sheet is not re-warped every run.
 */
function canonicalGcps(georeferencedMap: Record<string, unknown>): Array<[number | null, number | null, number | null, number | null]> {
  const gcps = Array.isArray(georeferencedMap.gcps) ? georeferencedMap.gcps as Array<Record<string, unknown>> : [];
  return gcps
    .map((gcp) => {
      const resource = Array.isArray(gcp.resource) ? gcp.resource : [];
      const geo = Array.isArray(gcp.geo) ? gcp.geo : [];
      return [round(resource[0], 2), round(resource[1], 2), round(geo[0], 9), round(geo[1], 9)] as [number | null, number | null, number | null, number | null];
    })
    .sort((a, b) => `${a}`.localeCompare(`${b}`));
}

/** Canonical resource-mask ring: pixel points rounded, rotated to a stable start. */
function canonicalMask(georeferencedMap: Record<string, unknown>): Array<[number | null, number | null]> {
  const mask = Array.isArray(georeferencedMap.resourceMask) ? georeferencedMap.resourceMask as unknown[] : [];
  const points = mask
    .filter((point): point is unknown[] => Array.isArray(point) && point.length >= 2)
    .map((point) => [round(point[0], 1), round(point[1], 1)] as [number | null, number | null]);
  if (points.length < 2) return points;
  // Rotate the ring so its lexicographically smallest point is first: the polygon
  // is identical under rotation, but a re-fetch may report a different start point.
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (`${points[i]}`.localeCompare(`${points[start]}`) < 0) start = i;
  }
  return [...points.slice(start), ...points.slice(0, start)];
}

/**
 * Content signature of everything that determines a canvas's warped GeoTIFF:
 * the resolved GCPs and resource mask, the transformation model, the capped
 * fetch width, and the source dimensions — plus the recipe version. Computable
 * from metadata alone (no image fetch), so the caller can decide whether a
 * re-warp is needed before touching the network or GDAL. Inputs are canonicalized
 * (rounded/sorted) so insignificant fetch-to-fetch noise does not bust the cache.
 */
export function warpSignature(georeferencedMap: Record<string, unknown>, transformationType: string | undefined): string {
  const resource = georeferencedMap.resource as Record<string, unknown> | undefined;
  return contentHash(
    "warp",
    WARP_RECIPE,
    rasterFetchWidth(),
    transformationType ?? "",
    round(resource?.width, 0),
    round(resource?.height, 0),
    canonicalGcps(georeferencedMap),
    canonicalMask(georeferencedMap),
  );
}

async function readMaskSidecar(path: string): Promise<MaskFeature | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as MaskFeature | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The most informative single line of a GDAL failure (prefer its ERROR line). */
function conciseGdalError(message: string): string {
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^ERROR\b/i.test(line)) ?? lines[lines.length - 1] ?? "failed";
}

/** Run a GDAL command, re-throwing failures as a short `tool: <error>` message. */
async function runGdal(tool: string, args: string[]): Promise<void> {
  try {
    await runCommand(tool, args);
  } catch (err) {
    throw new Error(`${tool}: ${conciseGdalError(err instanceof Error ? err.message : String(err))}`);
  }
}

async function validGeoTiff(path: string): Promise<boolean> {
  try {
    await runCommand("gdalinfo", ["-checksum", path]);
    return true;
  } catch {
    return false;
  }
}

export type MaskFeature = {
  type: "Feature";
  properties: { imageId: string; manifestUrl: string };
  geometry: Record<string, unknown>;
};

export type WarpResult = {
  geotiffPath: string;
  maskFeature: MaskFeature | null;
};

type Position = [number, number];

/** Map an Allmaps transformation type to the equivalent gdalwarp / gdaltransform model. */
export function gdalTransformArgs(type: string | undefined): string[] {
  // thinPlateSpline -> -tps; polynomial/helmert/unknown -> first-order polynomial,
  // matching the order-1 default the metadata stage already assumes.
  return type === "thinPlateSpline" ? ["-tps"] : ["-order", "1"];
}

/** Read the georeferencing transformation type from a raw Allmaps annotation page. */
export function annotationTransformationType(rawAnnotation: Record<string, unknown> | null): string | undefined {
  const items = Array.isArray(rawAnnotation?.items) ? rawAnnotation!.items as Array<Record<string, unknown>> : [];
  const body = items[0]?.body as Record<string, unknown> | undefined;
  const transformation = body?.transformation as Record<string, unknown> | undefined;
  const type = transformation?.type;
  return typeof type === "string" ? type : undefined;
}

function gcpArgs(georeferencedMap: Record<string, unknown>, scaleX: number, scaleY: number): string[] {
  const gcps = Array.isArray(georeferencedMap.gcps) ? georeferencedMap.gcps as Array<Record<string, unknown>> : [];
  const args: string[] = [];
  for (const gcp of gcps) {
    const resource = gcp.resource;
    const geo = gcp.geo;
    if (!Array.isArray(resource) || !Array.isArray(geo)) continue;
    const col = Number(resource[0]) * scaleX;
    const row = Number(resource[1]) * scaleY;
    const lon = Number(geo[0]);
    const lat = Number(geo[1]);
    if (![col, row, lon, lat].every(Number.isFinite)) continue;
    args.push("-gcp", col.toFixed(4), row.toFixed(4), String(lon), String(lat));
  }
  return args;
}

/** Resource-mask pixel points (scaled to the fetched image), closed into a ring. */
function maskRingPixels(georeferencedMap: Record<string, unknown>, scaleX: number, scaleY: number): Position[] {
  const mask = Array.isArray(georeferencedMap.resourceMask) ? georeferencedMap.resourceMask as unknown[] : [];
  const ring: Position[] = [];
  for (const point of mask) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = Number(point[0]) * scaleX;
    const y = Number(point[1]) * scaleY;
    if (Number.isFinite(x) && Number.isFinite(y)) ring.push([x, y]);
  }
  if (ring.length >= 3) {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  }
  return ring;
}

/**
 * Project mask pixel points into EPSG:4326 through the *same* GCP transform as the
 * warp, using gdaltransform (honors -tps / -order). This keeps the cutline exact
 * for TPS maps without reimplementing the transform in TS.
 */
async function pixelRingToGeo(gcpTif: string, transformArgs: string[], ring: Position[]): Promise<Position[]> {
  const input = ring.map(([x, y]) => `${x} ${y}`).join("\n") + "\n";
  const proc = Bun.spawn(["gdaltransform", ...transformArgs, "-t_srs", "EPSG:4326", gcpTif], {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`gdaltransform failed with exit ${code}${err ? `\n${err.trim()}` : ""}`);
  const geo: Position[] = [];
  for (const line of out.trim().split("\n")) {
    const [lon, lat] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(lon) && Number.isFinite(lat)) geo.push([lon!, lat!]);
  }
  return geo;
}

/**
 * Warp one canvas into an EPSG:3857 GeoTIFF and derive its geo footprint.
 *
 * Warps the *opaque* fetched image and clips with a geo cutline (mask points
 * projected through the same GCP transform). Because the source has no
 * transparent-black exterior, resampling never bleeds black into the map edge;
 * the transparent background is initialised white so gdal2tiles overviews don't
 * darken the border either. The cutline doubles as the masks.pmtiles feature.
 * Throws a concise Error on any fetch/warp failure; the caller logs the reason
 * and skips the canvas.
 */
export async function warpCanvas(params: {
  key: string;
  georeferencedMap: Record<string, unknown>;
  serviceId: string;
  info: Record<string, unknown> | null;
  imageId: string;
  manifestUrl: string;
  transformationType: string | undefined;
  workDir: string;
  /** Persistent cache destination for the warped GeoTIFF (keyed by warp signature). */
  outputTifPath: string;
  /** Persistent cache destination for the derived mask feature (sidecar JSON). */
  maskSidecarPath: string;
  /** Reuse an existing cached GeoTIFF instead of re-fetching + re-warping. */
  reuseCache: boolean;
}): Promise<WarpResult> {
  // Cache hit: an identical warp signature already produced this GeoTIFF, so skip
  // the source fetch and GDAL entirely and recover the mask from its sidecar.
  if (params.reuseCache && (await fileExists(params.outputTifPath))) {
    if (await validGeoTiff(params.outputTifPath)) {
      return { geotiffPath: params.outputTifPath, maskFeature: await readMaskSidecar(params.maskSidecarPath) };
    }
    await Promise.all([
      rm(params.outputTifPath, { force: true }),
      rm(params.maskSidecarPath, { force: true }),
    ]);
  }

  const resource = params.georeferencedMap.resource as Record<string, unknown> | undefined;
  const fullWidth = Number(resource?.width ?? params.info?.width);
  const fullHeight = Number(resource?.height ?? params.info?.height);
  if (!Number.isFinite(fullWidth) || !Number.isFinite(fullHeight) || fullWidth <= 0 || fullHeight <= 0) {
    throw new Error(`invalid source dimensions (${fullWidth}x${fullHeight})`);
  }

  const width = rasterFetchWidth();
  const buffer = await fetchWarpSource(params.serviceId, params.info, width, warpSourceCachePath(params.serviceId, width));
  const meta = await sharp(buffer).metadata();
  const fetchW = meta.width ?? 0;
  const fetchH = meta.height ?? 0;
  if (fetchW <= 0 || fetchH <= 0) throw new Error("fetched warp source has no dimensions");

  const scaleX = fetchW / fullWidth;
  const scaleY = fetchH / fullHeight;
  const gcps = gcpArgs(params.georeferencedMap, scaleX, scaleY);
  if (gcps.length < 3) throw new Error(`insufficient GCPs (${gcps.length} of 3 required)`);

  await ensureDir(params.workDir);
  await ensureDir(dirname(params.outputTifPath));
  const srcPath = join(params.workDir, `${params.key}_src.png`);
  const gcpPath = join(params.workDir, `${params.key}_gcp.tif`);
  const cutlinePath = join(params.workDir, `${params.key}_cutline.geojson`);
  const geotiffPath = params.outputTifPath;
  const tmpGeotiffPath = `${params.outputTifPath}.tmp-${process.pid}-${params.key}.tif`;
  const transformArgs = gdalTransformArgs(params.transformationType);

  // Decode to a clean opaque PNG (no alpha, no black exterior) for warping.
  await writeFile(srcPath, await sharp(buffer).removeAlpha().png().toBuffer());

  try {
    // 1. Attach GCPs (source pixel -> lon/lat) to the opaque image.
    await runGdal("gdal_translate", ["-of", "GTiff", "-a_srs", "EPSG:4326", ...gcps, srcPath, gcpPath]);

    // 2. Project the resource mask into geo space to use as a cutline / footprint.
    const ring = maskRingPixels(params.georeferencedMap, scaleX, scaleY);
    let maskFeature: MaskFeature | null = null;
    const cutlineArgs: string[] = [];
    if (ring.length >= 4) {
      const geoRing = await pixelRingToGeo(gcpPath, transformArgs, ring).catch(() => []);
      if (geoRing.length >= 4) {
        const geometry = { type: "Polygon", coordinates: [geoRing] };
        await writeFile(cutlinePath, JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry }] }));
        cutlineArgs.push("-cutline", cutlinePath, "-cutline_srs", "EPSG:4326", "-crop_to_cutline");
        maskFeature = { type: "Feature", properties: { imageId: params.imageId, manifestUrl: params.manifestUrl }, geometry };
      }
    }

    // 3. Warp to WebMercator with the map's real transformation model. Opaque
    //    source + white transparent background keeps map edges clean at every zoom.
    await runGdal("gdalwarp", [
      ...transformArgs,
      "-t_srs", "EPSG:3857",
      "-r", "lanczos",
      "-dstalpha",
      "-wo", "INIT_DEST=255,255,255,0",
      ...cutlineArgs,
      "-co", "COMPRESS=DEFLATE",
      "-overwrite",
      gcpPath,
      tmpGeotiffPath,
    ]);
    if (!await validGeoTiff(tmpGeotiffPath)) throw new Error("warped GeoTIFF failed validation");
    await rename(tmpGeotiffPath, geotiffPath);

    // Persist the mask sidecar next to the cached GeoTIFF so a later cache hit
    // can rebuild masks.pmtiles without re-warping.
    await writeFile(params.maskSidecarPath, JSON.stringify(maskFeature));
    return { geotiffPath, maskFeature };
  } finally {
    await Promise.all([rm(srcPath, { force: true }), rm(gcpPath, { force: true }), rm(cutlinePath, { force: true }), rm(tmpGeotiffPath, { force: true })]);
  }
}
