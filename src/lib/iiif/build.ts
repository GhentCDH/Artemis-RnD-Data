import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateId } from "@allmaps/id";
import { BuildLog, IIIF_WARNINGS_LOG_PATH } from "../build/buildLog";
import { runPool } from "../concurrency";
import { log } from "../log";
import { allmapsCanvasCacheDir, iiifCacheDir, layerOutDir, layerTmpDir } from "../paths";
import { ensureDir, writeJsonWithBrotli } from "../utils/files";
import { buildRasterPmtiles } from "../pmtiles/raster";
import { buildMasksPmtiles } from "../raster/masks";
import { buildXyzTiles } from "../raster/tiles";
import { annotationTransformationType, warpCanvas } from "../raster/warp";
import { analyzeAndSanitize, normalizeAnnotationPage, writeAnalysisLog } from "./analysis";
import { buildCompactGeomaps } from "./geomaps";
import { cachedJson } from "./json";
import {
  canvasId,
  canvasImageService,
  extractManifestCanvasAnnotation,
  fetchManifestAnnotation,
  iiifLabel,
  iiifSublayers,
  infoJson,
  manifestCanvases,
  mirrorCanvasAnnotation,
  pruneInfo,
  resolveIiifResource,
  shouldSkipManifest,
  textValues,
} from "./iiif";
import { calculateSpriteSize, fetchSprite, spriteCachePath, writeSpriteArtifacts } from "./sprites";
import type { IiifBuildOptions, IiifBuildResult, ProcessedCanvas, ProcessedManifest, SourceGroup } from "./types";

function maskSimplificationStats(processed: ProcessedManifest[]): { masks: number; before: number; after: number } {
  const stats = { masks: 0, before: 0, after: 0 };
  for (const manifest of processed) {
    for (const canvas of manifest.canvases) {
      for (const fix of canvas.analysis.fixes) {
        const match = fix.match(/^simplified-mask:(\d+)->(\d+)$/);
        if (!match) continue;
        stats.masks++;
        stats.before += Number(match[1]);
        stats.after += Number(match[2]);
      }
    }
  }
  return stats;
}

type LayerStats = { skipped: number; warnings: number; fixed: number; spriteFailed: number; warpFailed: number };

async function processManifest(group: SourceGroup, ref: { url: string; label: string }, options: IiifBuildOptions, stats: LayerStats, warningLog?: BuildLog, rasterWorkDir?: string): Promise<ProcessedManifest | null> {
  const manifest = await cachedJson(ref.url, iiifCacheDir("manifests")) as Record<string, unknown>;
  const manifestAllmapsId = await generateId(ref.url);
  const manifestAnnotation = await fetchManifestAnnotation(manifestAllmapsId).catch(() => null);
  const manifestLabel = iiifLabel(manifest.label) || ref.label;
  const processed: ProcessedCanvas[] = [];

  for (const canvas of manifestCanvases(manifest)) {
    const id = canvasId(canvas);
    const serviceId = canvasImageService(canvas);
    if (!id || !serviceId) continue;

    const canvasAllmapsId = await generateId(id);
    const rawAnnotation =
      await mirrorCanvasAnnotation(canvasAllmapsId).catch(() => null) ??
      await extractManifestCanvasAnnotation(manifestAllmapsId, canvasAllmapsId, serviceId, manifestAnnotation).catch(() => null);
    if (!rawAnnotation) continue;

    const georeferencedMap = normalizeAnnotationPage(rawAnnotation);
    if (!georeferencedMap) continue;

    // Per-canvas analyze detail goes to IIIFWarnings.log; the console gets one
    // aggregated line per layer (see buildLayerIiif) instead of a warning flood.
    const analyzed = analyzeAndSanitize(georeferencedMap);
    if (analyzed.analysis.after.errors.length > 0) {
      stats.skipped++;
      await writeAnalysisLog(warningLog, { layerId: group.layer.id, manifestUrl: ref.url, manifestLabel, canvasId: id, canvasAllmapsId, serviceId, analysis: analyzed.analysis, skipped: true });
      continue;
    }
    if (analyzed.analysis.fixes.length > 0) stats.fixed++;
    if (analyzed.analysis.after.warnings.length > 0) stats.warnings++;
    await writeAnalysisLog(warningLog, { layerId: group.layer.id, manifestUrl: ref.url, manifestLabel, canvasId: id, canvasAllmapsId, serviceId, analysis: analyzed.analysis, skipped: false });

    const info = pruneInfo(await infoJson(serviceId));
    const processedCanvas: ProcessedCanvas = { id, canvasAllmapsId, info, georeferencedMap: analyzed.map, serviceId, analysis: analyzed.analysis };
    const resource = analyzed.map.resource as Record<string, unknown> | undefined;
    const imageId = String(resource?.id ?? serviceId);
    const width = Number(info?.width);
    const height = Number(info?.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const size = calculateSpriteSize(width, height);
      try {
        const buffer = await fetchSprite(serviceId, info!, size, spriteCachePath(group.layer.id, canvasAllmapsId, size));
        processedCanvas.sprite = { canvasAllmapsId, imageId, fullWidth: width, fullHeight: height, spriteWidth: size.width, spriteHeight: size.height, buffer };
      } catch {
        stats.spriteFailed++;
      }
    }

    if (options.raster && rasterWorkDir) {
      try {
        const warp = await warpCanvas({
          key: canvasAllmapsId,
          georeferencedMap: analyzed.map,
          serviceId,
          info,
          imageId,
          manifestUrl: ref.url,
          transformationType: annotationTransformationType(rawAnnotation),
          workDir: rasterWorkDir,
        });
        if (warp) {
          processedCanvas.geotiffPath = warp.geotiffPath;
          if (warp.maskFeature) processedCanvas.maskFeature = warp.maskFeature;
        } else {
          stats.warpFailed++;
        }
      } catch {
        stats.warpFailed++;
      }
    }
    processed.push(processedCanvas);
  }

  if (processed.length === 0) return null;
  return {
    manifestUrl: ref.url,
    manifestLabel,
    manifestAllmapsId,
    isVerzamelblad: shouldSkipManifest({ ...manifest, label: [manifest.label, ref.label].flatMap(textValues).join(" ") }),
    canvases: processed,
  };
}

async function buildLayerIiif(group: SourceGroup, options: IiifBuildOptions, warningLog?: BuildLog): Promise<IiifBuildResult> {
  const refs = typeof options.limit === "number" ? group.refs.slice(0, options.limit) : group.refs;
  const rasterWorkDir = layerTmpDir(group.layer.id, "raster");
  if (options.raster) await rm(rasterWorkDir, { recursive: true, force: true });

  // Manifests are independent; warping dominates runtime, so process them with a
  // bounded pool (BUILD_CONCURRENCY). Results are written by index to keep the
  // geomaps/sprite order deterministic regardless of completion order.
  const stats: LayerStats = { skipped: 0, warnings: 0, fixed: 0, spriteFailed: 0, warpFailed: 0 };
  const ordered: (ProcessedManifest | null)[] = new Array(refs.length).fill(null);
  let done = 0;
  let warpedSoFar = 0;
  const step = Math.max(1, Math.round(refs.length / 10)); // ~10 progress lines per layer
  log.step(`${group.layer.id}: ${options.raster ? "warping" : "processing"} ${refs.length} IIIF manifests (${options.concurrency} workers)`);
  await runPool(refs, options.concurrency, async (ref, index) => {
    const item = await processManifest(group, ref, options, stats, warningLog, rasterWorkDir);
    ordered[index] = item;
    if (item && options.raster) warpedSoFar += item.canvases.filter((canvas) => canvas.geotiffPath).length;
    done++;
    if (done % step === 0 || done === refs.length) {
      log.info(`    ${group.layer.id}: ${done}/${refs.length} manifests${options.raster ? `, ${warpedSoFar} canvases warped` : ""}`);
    }
  });
  const processed = ordered.filter((item): item is ProcessedManifest => item !== null);

  if (stats.skipped + stats.warnings + stats.fixed + stats.spriteFailed + stats.warpFailed > 0) {
    const parts = [
      stats.skipped ? `${stats.skipped} skipped` : "",
      stats.warnings ? `${stats.warnings} with warnings` : "",
      stats.fixed ? `${stats.fixed} auto-fixed` : "",
      stats.spriteFailed ? `${stats.spriteFailed} sprite fails` : "",
      stats.warpFailed ? `${stats.warpFailed} warp fails` : "",
    ].filter(Boolean);
    log.warn(`${group.layer.id}: ${parts.join(", ")} — see ${IIIF_WARNINGS_LOG_PATH}`);
  }

  const outDir = layerOutDir(group.layer.id);
  await ensureDir(outDir);
  const spriteSources = processed.flatMap((manifest) => manifest.canvases.flatMap((canvas) => canvas.sprite ? [canvas.sprite] : []));
  const spritesMeta = await writeSpriteArtifacts(group.layer.id, outDir, spriteSources);
  await writeJsonWithBrotli(join(outDir, "geomaps.json"), buildCompactGeomaps(group.layer.id, processed), true);
  const maskStats = maskSimplificationStats(processed);
  const analysisErrors = processed.reduce((sum, manifest) => sum + manifest.canvases.reduce((inner, canvas) => inner + canvas.analysis.after.errors.length, 0), 0);
  const analysisWarnings = processed.reduce((sum, manifest) => sum + manifest.canvases.reduce((inner, canvas) => inner + canvas.analysis.after.warnings.length, 0), 0);
  const fixedMaps = processed.reduce((sum, manifest) => sum + manifest.canvases.filter((canvas) => canvas.analysis.fixes.length > 0).length, 0);

  // Raster stage: mosaic the warped canvas GeoTIFFs into raster.pmtiles and pack
  // their geo footprints into masks.pmtiles, then drop the scratch dir.
  let warpedCanvases = 0;
  let rasterPmtilesPath: string | undefined;
  let masksPmtilesPath: string | undefined;
  let masks = 0;
  if (options.raster) {
    const geotiffs = processed.flatMap((manifest) => manifest.canvases.flatMap((canvas) => canvas.geotiffPath ? [canvas.geotiffPath] : []));
    const maskFeatures = processed.flatMap((manifest) => manifest.canvases.flatMap((canvas) => canvas.maskFeature ? [canvas.maskFeature] : []));
    warpedCanvases = geotiffs.length;
    if (geotiffs.length > 0) {
      const tiles = await buildXyzTiles(geotiffs, rasterWorkDir, options.concurrency);
      if (tiles) {
        const target = join(outDir, "raster.pmtiles");
        await buildRasterPmtiles({ inputTilesDir: tiles.xyzDir, outputPmtiles: target, name: group.layer.id });
        rasterPmtilesPath = target;
      }
      const masksTarget = join(outDir, "masks.pmtiles");
      masks = await buildMasksPmtiles(maskFeatures, rasterWorkDir, masksTarget);
      if (masks > 0) masksPmtilesPath = masksTarget;
    }
    await rm(rasterWorkDir, { recursive: true, force: true });
  }

  const result: IiifBuildResult = {
    layerId: group.layer.id,
    manifests: processed.length,
    canvases: processed.reduce((sum, manifest) => sum + manifest.canvases.length, 0),
    sprites: spriteSources.length,
    analysisErrors,
    analysisWarnings,
    fixedMaps,
    simplifiedMasks: maskStats.masks,
    simplifiedMaskPointsBefore: maskStats.before,
    simplifiedMaskPointsAfter: maskStats.after,
    warpedCanvases,
    masks,
    warningLogPath: analysisErrors > 0 || analysisWarnings > 0 || fixedMaps > 0 ? IIIF_WARNINGS_LOG_PATH : undefined,
    geomapsPath: join(outDir, "geomaps.json"),
    spritesJsonPath: spritesMeta ? join(outDir, "sprites.json") : undefined,
    spritesImagePath: spritesMeta ? join(outDir, "sprites.jpg") : undefined,
    rasterPmtilesPath,
    masksPmtilesPath,
  };

  await options.buildLog?.section(`IIIF: ${group.layer.id}`);
  await options.buildLog?.fields({
    manifests: result.manifests,
    canvases: result.canvases,
    sprites: result.sprites,
    "analysis warnings": result.analysisWarnings,
    "analysis fixes": result.fixedMaps,
    "simplified masks": result.simplifiedMasks,
    "mask points before": result.simplifiedMaskPointsBefore,
    "mask points after": result.simplifiedMaskPointsAfter,
    "warped canvases": options.raster ? result.warpedCanvases : undefined,
    raster: result.rasterPmtilesPath,
    masks: result.masksPmtilesPath ? `${result.masks} (${result.masksPmtilesPath})` : undefined,
    "warning details": result.warningLogPath,
    geomaps: result.geomapsPath,
  });
  log.ok(`${group.layer.id}: ${result.manifests} IIIF manifests, ${result.canvases} canvases, ${result.sprites} sprites${options.raster ? `, ${result.warpedCanvases} warped` : ""}`);
  return result;
}

export async function buildIiif(options: IiifBuildOptions): Promise<IiifBuildResult[]> {
  await Promise.all([
    mkdir(iiifCacheDir("collections"), { recursive: true }),
    mkdir(iiifCacheDir("manifests"), { recursive: true }),
    mkdir(iiifCacheDir("info"), { recursive: true }),
    mkdir(iiifCacheDir("sprites"), { recursive: true }),
    mkdir(iiifCacheDir("warp"), { recursive: true }),
    mkdir(allmapsCanvasCacheDir(), { recursive: true }),
  ]);

  const groups: SourceGroup[] = [];
  for (const layer of options.layers) {
    for (const sublayer of iiifSublayers(layer)) {
      const resolved = await resolveIiifResource(sublayer.url);
      groups.push({ layer, sublayer, collectionUrl: sublayer.url, collectionLabel: resolved.label || layer.label, refs: resolved.refs });
    }
  }
  if (groups.length === 0) {
    log.warn("no IIIF source layers found");
    return [];
  }

  const warningLog = options.buildLog ? new BuildLog(IIIF_WARNINGS_LOG_PATH, "IIIF Warnings Log") : undefined;
  await warningLog?.reset("iiif warnings", [...new Set(groups.map((group) => group.layer.id))]);

  const results: IiifBuildResult[] = [];
  for (const group of groups) {
    results.push(options.buildLog ? await options.buildLog.timed(`iiif:${group.layer.id}`, () => buildLayerIiif(group, options, warningLog)) : await buildLayerIiif(group, options));
  }

  await options.buildLog?.section("IIIF Summary");
  const hasWarningsLog = results.some((result) => result.warningLogPath);
  await options.buildLog?.fields({
    layers: results.length,
    manifests: results.reduce((sum, result) => sum + result.manifests, 0),
    canvases: results.reduce((sum, result) => sum + result.canvases, 0),
    sprites: results.reduce((sum, result) => sum + result.sprites, 0),
    "analysis warnings": results.reduce((sum, result) => sum + result.analysisWarnings, 0),
    "analysis fixes": results.reduce((sum, result) => sum + result.fixedMaps, 0),
    "simplified masks": results.reduce((sum, result) => sum + result.simplifiedMasks, 0),
    "mask points before": results.reduce((sum, result) => sum + result.simplifiedMaskPointsBefore, 0),
    "mask points after": results.reduce((sum, result) => sum + result.simplifiedMaskPointsAfter, 0),
    "warped canvases": options.raster ? results.reduce((sum, result) => sum + result.warpedCanvases, 0) : undefined,
    "mask features": options.raster ? results.reduce((sum, result) => sum + result.masks, 0) : undefined,
    "warning details": hasWarningsLog ? IIIF_WARNINGS_LOG_PATH : undefined,
  });
  return results;
}
