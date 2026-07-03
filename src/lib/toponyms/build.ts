import { join, relative } from "node:path";
import type { FeatureCollection } from "../geojson/types";
import type { LayerRef } from "../layers/discovery";
import { layerOutDir, toponymsSrcDir } from "../paths";
import { runPool } from "../concurrency";
import { ensureDir, listFiles, readJsonFile, writeJsonBrotliOnly } from "../utils/files";
import { log } from "../log";
import { toponymItemsFromFeatureCollection, type ToponymItem } from "./normalize";
import type { BuildLog } from "../build/buildLog";

export type BuildToponymsOptions = {
  layers: LayerRef[];
  concurrency: number;
  buildLog?: BuildLog;
};

export type ToponymBuildResult = {
  layerId: string;
  sourceFiles: number;
  items: number;
  brotliPath?: string;
};

async function buildLayerToponyms(layer: LayerRef, options: BuildToponymsOptions): Promise<ToponymBuildResult> {
  const sourceDir = toponymsSrcDir(layer.id);
  const files = await listFiles(sourceDir, /\.(geojson|json)$/i);
  if (files.length === 0) return { layerId: layer.id, sourceFiles: 0, items: 0 };

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
  await writeJsonBrotliOnly(
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
    output: `${jsonPath}.br`,
  });
  return { layerId: layer.id, sourceFiles: files.length, items: items.length, brotliPath: `${jsonPath}.br` };
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
