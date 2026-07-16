import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { generateId } from "@allmaps/id";
import { BuildLog, IIIF_WARNINGS_LOG_PATH } from "../build/buildLog";
import { runPool } from "../concurrency";
import { log } from "../log";
import { allmapsCanvasCacheDir, iiifCacheDir, layerOutDir, layerTmpDir, warpTifCacheDir } from "../paths";
import { ensureDir, fileExists, writeJson } from "../utils/files";
import { contentHash } from "../utils/hash";
import { buildRasterPmtiles } from "../pmtiles/raster";
import { writeMasksGeojson } from "../raster/masks";
import { rasterConfigSignature } from "../raster/config";
import { buildXyzTiles } from "../raster/tiles";
import { annotationTransformationType, warpCanvas, warpSignature } from "../raster/warp";
import { analyzeAndSanitize, normalizeAnnotationPage, writeAnalysisLog, writeWarpFailureLog, type WarpFailure } from "./analysis";
import { buildCompactGeomaps } from "./geomaps";
import { buildIiifSearchIndex } from "./search";
import { VERZAMELBLAD_SPLITS } from "./config";
import { localize } from "../localization";
import { revalidatedJson } from "./json";
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

/** Bump to invalidate cached raster/mask outputs when the assembly recipe changes. */
const RASTER_RECIPE = 2;

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

async function processManifest(group: SourceGroup, ref: { url: string; label: string }, options: IiifBuildOptions, stats: LayerStats, warningLog?: BuildLog): Promise<ProcessedManifest | null> {
  const manifest = await revalidatedJson(ref.url, iiifCacheDir("manifests")) as Record<string, unknown>;
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

    // Warping is deferred to the (gated) raster phase; here we only carry the
    // inputs and a content signature of the canvas's georeference. Computed for
    // every build (cheap, metadata-only) so change detection and the live
    // "changed" counter work even without the raster stage.
    processedCanvas.imageId = imageId;
    processedCanvas.manifestUrl = ref.url;
    processedCanvas.transformationType = annotationTransformationType(rawAnnotation);
    processedCanvas.warpSig = warpSignature(analyzed.map, processedCanvas.transformationType);
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

  // Phase 1 (always): fetch + analyze every manifest/canvas. Cheap and needed to
  // detect change; the expensive warp is deferred to the gated raster phase.
  // Manifests are independent, so process them with a bounded pool
  // (BUILD_CONCURRENCY); results are stored by index to keep geomaps/sprite order
  // deterministic regardless of completion order.
  // Previous build's per-canvas signatures, to report how many changed live.
  const hashes = options.registry ? await options.registry.layer(group.layer.id) : undefined;
  const hadPrevBuild = hashes?.hasCategory("canvas") ?? false;

  const stats: LayerStats = { skipped: 0, warnings: 0, fixed: 0, spriteFailed: 0, warpFailed: 0 };
  const ordered: (ProcessedManifest | null)[] = new Array(refs.length).fill(null);
  let done = 0;
  let seenCanvases = 0;
  let changedCanvases = 0;
  const step = Math.max(1, Math.round(refs.length / 10)); // ~10 progress lines per layer
  log.step(`${group.layer.id}: processing ${refs.length} IIIF manifests (${options.concurrency} workers)`);
  await runPool(refs, options.concurrency, async (ref, index) => {
    const item = await processManifest(group, ref, options, stats, warningLog);
    ordered[index] = item;
    for (const canvas of item?.canvases ?? []) {
      seenCanvases++;
      if (hashes?.prevHash(canvas.id) !== canvas.warpSig) changedCanvases++;
    }
    done++;
    if (done % step === 0 || done === refs.length) {
      const changed = hadPrevBuild ? `, ${changedCanvases}/${seenCanvases} changed` : `, ${seenCanvases} canvases (no cache)`;
      log.info(`    ${group.layer.id}: ${done}/${refs.length} manifests${changed}`);
    }
  });
  const processed = ordered.filter((item): item is ProcessedManifest => item !== null);

  // Canvas hashes (source URL → warp signature) recorded for this layer. Records
  // the "canvas" category so it is written even on --no-raster / metadata-only
  // runs; `canvasUnchanged` also drives the raster skip below.
  const canvasEntries: Array<[string, string]> = processed.flatMap((manifest) =>
    manifest.canvases.flatMap((canvas) => (canvas.warpSig ? [[canvas.id, canvas.warpSig] as [string, string]] : [])),
  );
  const canvasUnchanged = hashes?.categoryUnchanged("canvas", canvasEntries) ?? false;
  log.ok(hadPrevBuild
    ? `${group.layer.id}: ${changedCanvases} of ${seenCanvases} canvases changed since last build`
    : `${group.layer.id}: ${seenCanvases} canvases, no cache — building all`);

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
  log.info(`    ${group.layer.id}: packing ${spriteSources.length} sprites + geomaps`);
  const spritesMeta = await writeSpriteArtifacts(group.layer.id, outDir, spriteSources, options.concurrency);
  await writeJson(join(outDir, "geomaps.json"), buildCompactGeomaps(group.layer.id, processed), true);
  await writeJson(join(outDir, "search.json"), buildIiifSearchIndex(group.layer.id, group.layer.label, processed), true);
  const maskStats = maskSimplificationStats(processed);
  const analysisErrors = processed.reduce((sum, manifest) => sum + manifest.canvases.reduce((inner, canvas) => inner + canvas.analysis.after.errors.length, 0), 0);
  const analysisWarnings = processed.reduce((sum, manifest) => sum + manifest.canvases.reduce((inner, canvas) => inner + canvas.analysis.after.warnings.length, 0), 0);
  const fixedMaps = processed.reduce((sum, manifest) => sum + manifest.canvases.filter((canvas) => canvas.analysis.fixes.length > 0).length, 0);

  // Raster stage (gated): if no manifest or georeference annotation in this layer
  // changed, the whole warp + mosaic + tiling + masks step is skipped. Otherwise
  // each canvas is warped through the per-canvas GeoTIFF cache (so a single edited
  // sheet only re-warps itself), then mosaicked into raster.pmtiles + masks.geojson.
  let warpedCanvases = 0;
  let rasterPmtilesPath: string | undefined;
  let masksGeojsonPath: string | undefined;
  let masks = 0;
  if (options.raster) {
    const rasterTarget = join(outDir, "raster.pmtiles");
    const masksTarget = join(outDir, "masks.geojson");
    // (The retired masks.pmtiles is now swept by pruneStaleLayerOutputs in the layers step.)
    const rasterCanvases = processed.flatMap((manifest) => manifest.canvases.filter((canvas) => canvas.warpSig));
    // Raster is fresh when both the canvas georeferences (canvasUnchanged, above)
    // and the raster tiling config (@raster) match the committed registry.
    const rasterParamHash = contentHash("raster", RASTER_RECIPE, rasterConfigSignature());
    const rasterParamUnchanged = hashes?.categoryUnchanged("raster", [["@raster", rasterParamHash]]) ?? false;
    const rasterFresh = !options.registry?.force && canvasUnchanged && rasterParamUnchanged && (await fileExists(rasterTarget)) && (await fileExists(masksTarget));

    if (rasterFresh) {
      log.ok(`${group.layer.id}: raster unchanged — skipped warp + tiling (${rasterCanvases.length} canvases)`);
      rasterPmtilesPath = rasterTarget;
      masksGeojsonPath = masksTarget;
    } else {
      const reason = !hadPrevBuild
        ? "no cache"
        : changedCanvases > 0
          ? `${changedCanvases}/${seenCanvases} canvases changed`
          : !rasterParamUnchanged
            ? "raster config changed"
            : "output missing";
      log.step(`${group.layer.id}: raster rebuild (${reason})`);
      const rasterWorkDir = layerTmpDir(group.layer.id, "raster");
      await rm(rasterWorkDir, { recursive: true, force: true });
      const cacheDir = warpTifCacheDir(group.layer.id);
      const reuse = !options.registry?.force;

      let warpDone = 0;
      const warpStep = Math.max(1, Math.round(rasterCanvases.length / 10));
      const warpFailures: WarpFailure[] = [];
      log.step(`${group.layer.id}: warping ${rasterCanvases.length} canvases (${options.concurrency} workers)`);
      await runPool(rasterCanvases, options.concurrency, async (canvas) => {
        try {
          const warp = await warpCanvas({
            key: canvas.canvasAllmapsId,
            georeferencedMap: canvas.georeferencedMap,
            serviceId: canvas.serviceId,
            info: canvas.info,
            imageId: canvas.imageId ?? canvas.serviceId,
            manifestUrl: canvas.manifestUrl ?? "",
            transformationType: canvas.transformationType,
            workDir: rasterWorkDir,
            outputTifPath: join(cacheDir, `${canvas.canvasAllmapsId}_${canvas.warpSig}.tif`),
            maskSidecarPath: join(cacheDir, `${canvas.canvasAllmapsId}_${canvas.warpSig}.mask.json`),
            reuseCache: reuse,
          });
          canvas.geotiffPath = warp.geotiffPath;
          if (warp.maskFeature) canvas.maskFeature = warp.maskFeature;
        } catch (err) {
          stats.warpFailed++;
          warpFailures.push({ canvasId: canvas.id, manifestUrl: canvas.manifestUrl, reason: err instanceof Error ? err.message : String(err) });
        }
        warpDone++;
        if (warpDone % warpStep === 0 || warpDone === rasterCanvases.length) {
          log.info(`    ${group.layer.id}: ${warpDone}/${rasterCanvases.length} canvases warped`);
        }
      });
      if (warpFailures.length > 0) {
        log.warn(`${group.layer.id}: ${warpFailures.length} of ${rasterCanvases.length} canvases failed to warp — see ${IIIF_WARNINGS_LOG_PATH}`);
        await writeWarpFailureLog(warningLog, group.layer.id, warpFailures);
      }

      const geotiffs = rasterCanvases.flatMap((canvas) => canvas.geotiffPath ? [canvas.geotiffPath] : []);
      const maskFeatures = rasterCanvases.flatMap((canvas) => canvas.maskFeature ? [canvas.maskFeature] : []);
      warpedCanvases = geotiffs.length;
      if (geotiffs.length > 0) {
        log.step(`${group.layer.id}: mosaicking ${geotiffs.length} canvases → XYZ tiles (gdal2tiles)`);
        const tiles = await buildXyzTiles(geotiffs, rasterWorkDir, options.concurrency);
        if (tiles) {
          log.info(`    ${group.layer.id}: packing raster.pmtiles`);
          await buildRasterPmtiles({ inputTilesDir: tiles.xyzDir, outputPmtiles: rasterTarget, name: group.layer.id });
          rasterPmtilesPath = rasterTarget;
        }
        log.info(`    ${group.layer.id}: writing masks.geojson (${maskFeatures.length} features)`);
        masks = await writeMasksGeojson(maskFeatures, masksTarget);
        masksGeojsonPath = masksTarget;
      }
      await rm(rasterWorkDir, { recursive: true, force: true });
      if (rasterCanvases.length > 0 && !rasterPmtilesPath) {
        log.warn(`${group.layer.id}: produced no raster output (all ${rasterCanvases.length} canvases failed to warp)`);
      }
    }
  }

  // Registry entries recorded above (canvas + raster categories) are only written
  // to the committed hashes.txt by registry.flushAll() at the very end of the
  // build — so a cancel or throw mid-build never advances the baseline, and the
  // fileExists guard on the raster gate re-runs anything left incomplete.

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
    searchPath: join(outDir, "search.json"),
    spritesJsonPath: spritesMeta ? join(outDir, "sprites.json") : undefined,
    spritesImagePath: spritesMeta ? join(outDir, "sprites.webp") : undefined,
    spritesDirPath: spritesMeta ? join(outDir, "sprites") : undefined,
    rasterPmtilesPath,
    masksGeojsonPath,
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
    masks: result.masksGeojsonPath ? `${result.masks} (${result.masksGeojsonPath})` : undefined,
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

      // Hardcoded splits (see VERZAMELBLAD_SPLITS): built as an independent
      // group under the split's own synthetic id, so it gets its own output
      // dir/hashes.txt/registry namespace via the same group.layer.id-keyed
      // helpers every other layer already uses - no special-casing needed
      // anywhere else in buildLayerIiif.
      for (const split of VERZAMELBLAD_SPLITS) {
        if (split.parentSublayerId !== sublayer.id || resolved.verzamelbladRefs.length === 0) continue;
        groups.push({
          layer: { ...layer, id: split.id },
          sublayer: { id: split.id, url: sublayer.url },
          collectionUrl: sublayer.url,
          collectionLabel: `${resolved.label || layer.label} — ${localize(split.name, "nl")}`,
          refs: resolved.verzamelbladRefs,
        });
      }
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
