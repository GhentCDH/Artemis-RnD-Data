import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir } from "../utils/files";
import type { MaskFeature } from "./warp";

/**
 * Write masks.geojson from the per-canvas geo footprints recovered during warp.
 * One polygon per canvas with `imageId` + `manifestUrl`.
 */
export async function writeMasksGeojson(features: MaskFeature[], outputGeojson: string): Promise<number> {
  await ensureDir(dirname(outputGeojson));
  await writeFile(outputGeojson, JSON.stringify({ type: "FeatureCollection", features }));
  return features.length;
}
