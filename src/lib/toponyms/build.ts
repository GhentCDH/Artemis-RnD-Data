import { join, relative } from "node:path";
import type { FeatureCollection } from "../geojson/types";
import type { LayerRef } from "../layers/discovery";
import { layerOutDir, toponymsSrcDir } from "../paths";
import { runPool } from "../concurrency";
import { ensureDir, fileExists, hashFile, listFiles, readJsonFile, writeJson } from "../utils/files";
import { contentHash } from "../utils/hash";
import { log } from "../log";
import { toponymItemsFromFeatureCollection, type ToponymItem } from "./normalize";
import type { BuildLog } from "../build/buildLog";
import type { HashRegistry } from "../build/hashRegistry";

/** Bump to invalidate cached toponym outputs when the normalization changes. */
const TOPONYMS_RECIPE = 2;

export type BuildToponymsOptions = {
  layers: LayerRef[];
  concurrency: number;
  buildLog?: BuildLog;
  registry?: HashRegistry;
};

export type ToponymBuildResult = {
  layerId: string;
  sourceFiles: number;
  items: number;
  jsonPath?: string;
  cached?: boolean;
};

async function buildLayerToponyms(layer: LayerRef, options: BuildToponymsOptions): Promise<ToponymBuildResult> {
  const sourceDir = toponymsSrcDir(layer.id);
  const files = await listFiles(sourceDir, /\.(geojson|json)$/i);
  if (files.length === 0) return { layerId: layer.id, sourceFiles: 0, items: 0 };

  const outPath = join(layerOutDir(layer.id), "toponyms.json");
  const hashes = options.registry ? await options.registry.layer(layer.id) : undefined;
  const entries: Array<[string, string]> = [["@toponyms", contentHash("toponyms", TOPONYMS_RECIPE)]];
  for (const file of files) entries.push([file.replace(/\\/g, "/"), await hashFile(file)]);
  const unchanged = hashes?.categoryUnchanged("toponyms", entries) ?? false;
  if (!options.registry?.force && unchanged && await fileExists(outPath)) {
    log.ok(`${layer.id}: toponyms unchanged — skipped`);
    return { layerId: layer.id, sourceFiles: files.length, items: 0, jsonPath: outPath, cached: true };
  }

  const items: ToponymItem[] = [];
  await runPool(files, options.concurrency, async (file) => {
    const geojson = await readJsonFile<FeatureCollection>(file);
    if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
      throw new Error(`${file} is not a FeatureCollection`);
    }
    const sourceFile = relative(sourceDir, file).replace(/\\/g, "/");
    items.push(...toponymItemsFromFeatureCollection(geojson, layer.id, sourceFile));
  });

  items.sort((a, b) => a.text.localeCompare(b.text) || a.id.localeCompare(b.id));

  const outDir = layerOutDir(layer.id);
  await ensureDir(outDir);

  const jsonPath = join(outDir, "toponyms.json");
  await writeJson(
    jsonPath,
    {
      generatedAt: new Date().toISOString(),
      map: layer.id,
      mapLabel: layer.label,
      itemCount: items.length,
      items,
    },
    true,
  );

  log.ok(`${layer.id}: ${items.length} toponyms from ${files.length} files`);
  await options.buildLog?.section(`Toponyms: ${layer.id}`);
  await options.buildLog?.fields({
    "source files": files.length,
    items: items.length,
    output: jsonPath,
  });
  return { layerId: layer.id, sourceFiles: files.length, items: items.length, jsonPath };
}

export async function buildToponyms(options: BuildToponymsOptions): Promise<ToponymBuildResult[]> {
  const results: ToponymBuildResult[] = [];
  for (const layer of options.layers) {
    const result = options.buildLog
      ? await options.buildLog.timed(`toponyms:${layer.id}`, () => buildLayerToponyms(layer, options))
      : await buildLayerToponyms(layer, options);
    if (result.sourceFiles > 0) results.push(result);
  }

  const totalItems = results.reduce((sum, result) => sum + result.items, 0);
  log.ok(`toponyms total: ${totalItems} items across ${results.length} layers`);
  await options.buildLog?.section("Toponyms Summary");
  await options.buildLog?.fields({ layers: results.length, items: totalItems });
  if (results.length === 0) log.warn("no toponym source files found");
  return results;
}
