import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildVectorPmtiles, vectorTileBuffer } from "../pmtiles/vector";
import {
  BUILD_BASELAYER_PMTILES_PATH,
  BUILD_TMP_DIR,
  sourceBaselayerBorderPath,
  sourceBaselayerWaterPath,
} from "../paths";
import { fileExists } from "../utils/files";
import { log } from "../log";
import type { BuildLog } from "../build/buildLog";
import { validateBaselayerGeoJson } from "./validate";

export type BuildBaselayerOptions = {
  buildLog?: BuildLog;
};

export type BaselayerBuildResult = {
  published: boolean;
  pmtilesPath?: string;
};

/**
 * Publishes the site-wide water and border polygons as separate vector source
 * layers in one archive. Keeping them separate lets the viewer independently
 * control their color, opacity, and z-order.
 */
export async function buildBaselayer(options: BuildBaselayerOptions = {}): Promise<BaselayerBuildResult> {
  const waterPath = sourceBaselayerWaterPath();
  const borderPath = sourceBaselayerBorderPath();
  const missing = [];
  if (!(await fileExists(waterPath))) missing.push(waterPath);
  if (!(await fileExists(borderPath))) missing.push(borderPath);
  if (missing.length > 0) {
    log.warn(`missing baselayer input(s): ${missing.join(", ")}; skipping baselayer pmtiles`);
    return { published: false };
  }

  for (const path of [waterPath, borderPath]) {
    const issues = await validateBaselayerGeoJson(path);
    if (issues.length === 0) continue;
    const details = issues.map((issue) => `${issue.path ? `${issue.path}: ` : ""}${issue.message}`).join("; ");
    const message = `invalid baselayer input ${path}: ${details}`;
    log.warn(message);
    throw new Error(message);
  }

  const tmpDir = join(BUILD_TMP_DIR, "baselayer");
  try {
    await buildVectorPmtiles({
      inputLayers: [
        { name: "water", inputGeojson: waterPath },
        { name: "border", inputGeojson: borderPath },
      ],
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
  await options.buildLog?.fields({ water: waterPath, border: borderPath, output: BUILD_BASELAYER_PMTILES_PATH });

  return { published: true, pmtilesPath: BUILD_BASELAYER_PMTILES_PATH };
}
