import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir } from "../utils/files";
import { runCommand } from "../utils/run";
import { xyzDirToMbtiles } from "./mbtiles";

export type RasterPmtilesOptions = {
  inputTilesDir: string;
  outputPmtiles: string;
  /** Optional name stored in MBTiles metadata (defaults to "raster"). */
  name?: string;
};

/**
 * Pack a gdal2tiles `--xyz` tile directory into a raster PMTiles archive.
 * go-pmtiles `convert` only accepts MBTiles, so the XYZ tree is first bridged
 * into a temporary MBTiles (see xyzDirToMbtiles) and then converted + removed.
 */
export async function buildRasterPmtiles(options: RasterPmtilesOptions): Promise<void> {
  await ensureDir(dirname(options.outputPmtiles) || ".");
  const mbtilesPath = `${options.outputPmtiles.replace(/\.pmtiles$/i, "")}.mbtiles`;
  await rm(mbtilesPath, { force: true });
  await rm(options.outputPmtiles, { force: true });

  try {
    await xyzDirToMbtiles(options.inputTilesDir, mbtilesPath, { name: options.name });
    await runCommand("pmtiles", ["convert", mbtilesPath, options.outputPmtiles]);
  } finally {
    await rm(mbtilesPath, { force: true });
  }
}
