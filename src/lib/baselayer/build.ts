import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildVectorPmtiles, vectorTileBuffer } from "../pmtiles/vector";
import {
  BUILD_BASELAYER_BORDER_PMTILES_PATH,
  BUILD_BASELAYER_WATER_PMTILES_PATH,
  BUILD_DIR,
  BUILD_TMP_DIR,
  RETIRED_BUILD_BASELAYER_PMTILES_PATH,
  sourceBaselayerBorderPath,
  sourceBaselayerWaterPath,
} from "../paths";
import { ensureDir, fileExists } from "../utils/files";
import { log } from "../log";
import type { BuildLog } from "../build/buildLog";
import { validateBaselayerGeoJson, validateBaselayerPmtiles } from "./validate";

export type BuildBaselayerOptions = {
  buildLog?: BuildLog;
};

export type BaselayerBuildResult = {
  published: boolean;
  waterPmtilesPath?: string;
  borderPmtilesPath?: string;
};

/**
 * Publishes the prebuilt water tiles and tiles the authored border GeoJSON into
 * separate archives. The viewer can load and style both sources independently.
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

  const waterIssues = await validateBaselayerPmtiles(waterPath);
  if (waterIssues.length > 0) {
    const details = waterIssues.map((issue) => issue.message).join("; ");
    const message = `invalid baselayer input ${waterPath}: ${details}`;
    log.warn(message);
    throw new Error(message);
  }

  const borderIssues = await validateBaselayerGeoJson(borderPath);
  if (borderIssues.length > 0) {
    const details = borderIssues.map((issue) => `${issue.path ? `${issue.path}: ` : ""}${issue.message}`).join("; ");
    const message = `invalid baselayer input ${borderPath}: ${details}`;
    log.warn(message);
    throw new Error(message);
  }

  const tmpDir = join(BUILD_TMP_DIR, "baselayer");
  try {
    await ensureDir(BUILD_DIR);
    await buildVectorPmtiles({
      inputGeojson: borderPath,
      outputPmtiles: BUILD_BASELAYER_BORDER_PMTILES_PATH,
      tmpDir,
      layerName: "border",
      minZoom: 0,
      maxZoom: 14,
      buffer: vectorTileBuffer(),
    });
    await copyFile(waterPath, BUILD_BASELAYER_WATER_PMTILES_PATH);
    await rm(RETIRED_BUILD_BASELAYER_PMTILES_PATH, { force: true });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  log.ok(`baselayer: published ${BUILD_BASELAYER_WATER_PMTILES_PATH} + ${BUILD_BASELAYER_BORDER_PMTILES_PATH}`);
  await options.buildLog?.section("Baselayer");
  await options.buildLog?.fields({
    water: `${waterPath} -> ${BUILD_BASELAYER_WATER_PMTILES_PATH}`,
    border: `${borderPath} -> ${BUILD_BASELAYER_BORDER_PMTILES_PATH}`,
  });

  return {
    published: true,
    waterPmtilesPath: BUILD_BASELAYER_WATER_PMTILES_PATH,
    borderPmtilesPath: BUILD_BASELAYER_BORDER_PMTILES_PATH,
  };
}
