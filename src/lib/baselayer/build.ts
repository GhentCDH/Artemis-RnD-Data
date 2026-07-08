import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildVectorPmtiles, vectorTileBuffer } from "../pmtiles/vector";
import { BUILD_BASELAYER_PMTILES_PATH, BUILD_TMP_DIR, sourceBaselayerPath } from "../paths";
import { fileExists } from "../utils/files";
import { log } from "../log";
import type { BuildLog } from "../build/buildLog";

export type BuildBaselayerOptions = {
  buildLog?: BuildLog;
};

export type BaselayerBuildResult = {
  published: boolean;
  pmtilesPath?: string;
};

/**
 * Publishes the site-wide reference boundary layer (`Baselayer.geojson`, not
 * tied to any single historical map) as vector tiles - a straight
 * geojson-to-pmtiles conversion, unlike parcels/masks there's no per-feature
 * normalization or simplification to do first.
 */
export async function buildBaselayer(options: BuildBaselayerOptions = {}): Promise<BaselayerBuildResult> {
  const inputPath = sourceBaselayerPath();
  if (!(await fileExists(inputPath))) {
    log.warn(`no Baselayer.geojson at ${inputPath}; skipping baselayer pmtiles`);
    return { published: false };
  }

  const tmpDir = join(BUILD_TMP_DIR, "baselayer");
  try {
    await buildVectorPmtiles({
      inputGeojson: inputPath,
      outputPmtiles: BUILD_BASELAYER_PMTILES_PATH,
      tmpDir,
      layerName: "baselayer",
      minZoom: 0,
      maxZoom: 14,
      buffer: vectorTileBuffer(),
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  log.ok(`baselayer: published ${BUILD_BASELAYER_PMTILES_PATH}`);
  await options.buildLog?.section("Baselayer");
  await options.buildLog?.fields({ input: inputPath, output: BUILD_BASELAYER_PMTILES_PATH });

  return { published: true, pmtilesPath: BUILD_BASELAYER_PMTILES_PATH };
}
