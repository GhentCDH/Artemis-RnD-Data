import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { ensureDir } from "../utils/files";
import { runCommand } from "../utils/run";
import { rasterFetchWidth } from "./config";
import { fetchWarpSource, warpSourceCachePath } from "./fetch";

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
 * Returns null on any fetch/warp failure so the caller can skip the canvas.
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
}): Promise<WarpResult | null> {
  const resource = params.georeferencedMap.resource as Record<string, unknown> | undefined;
  const fullWidth = Number(resource?.width ?? params.info?.width);
  const fullHeight = Number(resource?.height ?? params.info?.height);
  if (!Number.isFinite(fullWidth) || !Number.isFinite(fullHeight) || fullWidth <= 0 || fullHeight <= 0) return null;

  const width = rasterFetchWidth();
  const buffer = await fetchWarpSource(params.serviceId, params.info, width, warpSourceCachePath(params.serviceId, width));
  const meta = await sharp(buffer).metadata();
  const fetchW = meta.width ?? 0;
  const fetchH = meta.height ?? 0;
  if (fetchW <= 0 || fetchH <= 0) return null;

  const scaleX = fetchW / fullWidth;
  const scaleY = fetchH / fullHeight;
  const gcps = gcpArgs(params.georeferencedMap, scaleX, scaleY);
  if (gcps.length < 3) return null;

  await ensureDir(params.workDir);
  const srcPath = join(params.workDir, `${params.key}_src.png`);
  const gcpPath = join(params.workDir, `${params.key}_gcp.tif`);
  const cutlinePath = join(params.workDir, `${params.key}_cutline.geojson`);
  const geotiffPath = join(params.workDir, `${params.key}.tif`);
  const transformArgs = gdalTransformArgs(params.transformationType);

  // Decode to a clean opaque PNG (no alpha, no black exterior) for warping.
  await writeFile(srcPath, await sharp(buffer).removeAlpha().png().toBuffer());

  try {
    // 1. Attach GCPs (source pixel -> lon/lat) to the opaque image.
    await runCommand("gdal_translate", ["-of", "GTiff", "-a_srs", "EPSG:4326", ...gcps, srcPath, gcpPath]);

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
    await runCommand("gdalwarp", [
      ...transformArgs,
      "-t_srs", "EPSG:3857",
      "-r", "lanczos",
      "-dstalpha",
      "-wo", "INIT_DEST=255,255,255,0",
      ...cutlineArgs,
      "-co", "COMPRESS=DEFLATE",
      "-overwrite",
      gcpPath,
      geotiffPath,
    ]);

    return { geotiffPath, maskFeature };
  } finally {
    await Promise.all([rm(srcPath, { force: true }), rm(gcpPath, { force: true }), rm(cutlinePath, { force: true })]);
  }
}
