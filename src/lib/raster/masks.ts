import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../utils/files";
import { buildVectorPmtiles } from "../pmtiles/vector";
import { rasterMaxZoom, rasterMinZoom } from "./config";
import type { MaskFeature } from "./warp";

/**
 * Build masks.pmtiles from the per-canvas geo footprints recovered during warp.
 * One polygon per canvas with `imageId` + `manifestUrl`, in a `masks` layer.
 */
export async function buildMasksPmtiles(features: MaskFeature[], workDir: string, outputPmtiles: string, buffer?: number): Promise<number> {
  if (features.length === 0) return 0;
  await ensureDir(workDir);
  const geojsonPath = join(workDir, "masks.geojson");
  await writeFile(geojsonPath, JSON.stringify({ type: "FeatureCollection", features }));

  await buildVectorPmtiles({
    inputGeojson: geojsonPath,
    outputPmtiles,
    tmpDir: workDir,
    layerName: "masks",
    minZoom: rasterMinZoom(),
    maxZoom: rasterMaxZoom(),
    buffer,
  });
  await rm(geojsonPath, { force: true });
  return features.length;
}
