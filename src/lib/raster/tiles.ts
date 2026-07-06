import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../utils/files";
import { runCommand } from "../utils/run";
import { gdal2tilesDriver, rasterMaxZoom, rasterMinZoom, rasterTileFormat, rasterTileSize, rasterWebpQuality } from "./config";

export type XyzTilesResult = { xyzDir: string; minZoom: number; maxZoom: number; format: "webp" | "png" | "jpeg" };

/**
 * Build a WebMercator XYZ tile pyramid from warped canvas GeoTIFFs:
 * gdalbuildvrt mosaics them, gdal2tiles renders `{z}/{x}/{y}.<ext>` in the
 * chosen format/zoom range. Alpha from the warp is preserved (WEBP/PNG).
 */
export async function buildXyzTiles(geotiffs: string[], workDir: string, workers: number): Promise<XyzTilesResult | null> {
  if (geotiffs.length === 0) return null;
  const minZoom = rasterMinZoom();
  const maxZoom = rasterMaxZoom();
  const format = rasterTileFormat();

  await ensureDir(workDir);
  const vrtPath = join(workDir, "mosaic.vrt");
  const xyzDir = join(workDir, "xyz");
  await rm(vrtPath, { force: true });
  await rm(xyzDir, { recursive: true, force: true });

  await runCommand("gdalbuildvrt", ["-overwrite", vrtPath, ...geotiffs]);

  const args = [
    "--xyz",
    "-r", "lanczos",
    "--tilesize", String(rasterTileSize()),
    "--tiledriver", gdal2tilesDriver(format),
    "--zoom", `${minZoom}-${maxZoom}`,
    "--processes", String(Math.max(1, workers)),
  ];
  if (format === "webp") args.push("--webp-quality", String(rasterWebpQuality()));
  args.push(vrtPath, xyzDir);
  // Stream gdal2tiles' native progress bar so the long tiling step isn't silent.
  await runCommand("gdal2tiles.py", args, { stdio: "inherit" });

  return { xyzDir, minZoom, maxZoom, format };
}
