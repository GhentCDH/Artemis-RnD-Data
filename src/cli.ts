#!/usr/bin/env bun
import { buildParcels } from "./lib/parcels/build";
import { buildToponyms } from "./lib/toponyms/build";
import { buildIiif } from "./lib/iiif/build";
import { buildImageCollections } from "./lib/imageCollections/build";
import { discoverLayers } from "./lib/layers/discovery";
import { publishLayers, significantIssues, type PublishLayersResult } from "./lib/layers/publish";
import { log } from "./lib/log";
import { cpus } from "node:os";
import { BuildLog } from "./lib/build/buildLog";
import { HashRegistry, buildForceEnabled } from "./lib/build/hashRegistry";
import { BUILD_ZENODO_SOURCE_PATH, setSourceDir, sourceDir } from "./lib/paths";
import { detectZenodoDraftStatus, listDraftFiles, syncZenodoSource } from "./lib/source/zenodo";
import { writeJson } from "./lib/utils/files";

const DEFAULT_ZENODO_RECORD = "21219182";

const COMMANDS = {
  build: "Build everything (or the given layer ids) into build/",
  iiif: "Build IIIF geomaps and sprites",
  toponyms: "Build toponym search JSON",
  parcels: "Build parcel PMTiles",
  imagecollections: "Build non-georeferenced image collections",
  layers: "Merge Source/layers/* into build/layers.yaml",
  "source:sync": "Download and extract Source.zip from a Zenodo record into the local source mirror cache",
  "source:draft-files": "List the files Zenodo reports for an unpublished draft, given the draft's own record id (requires ZENODO_TOKEN)",
  help: "Show this help",
} as const;

function concurrency(): number {
  const parsed = Number.parseInt(process.env.BUILD_CONCURRENCY ?? "", 10);
  // An explicit BUILD_CONCURRENCY is honored as-is (uncapped). The auto-default
  // is capped at 8: the work is mostly I/O-bound (remote IIIF fetches), so more
  // workers mainly add load on the upstream server, and each raster worker holds
  // a sharp/GDAL job in memory. Conservative ceiling — raise via env if needed.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(1, Math.min(8, cpus().length || 4));
}

function help(): void {
  console.log("artemis-data (v2)\n\nUsage:\n  bun run src/cli.ts <command> [zenodoRecordId] [layerId...] [--no-raster] [--force] [--local-source]\n\nCommands:");
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${desc}`);
  }
  console.log("\nFlags:");
  console.log("  --no-raster                Skip the raster warp (geomaps + sprites only) for build/iiif");
  console.log("  --force                    Rebuild everything, bypassing the incremental build cache");
  console.log("  --local-source             Read from local Source/ instead of the Zenodo mirror");
  console.log("  --zenodo-record <id>       Explicit alternative to positional zenodoRecordId");
  console.log("\nEnvironment:");
  console.log("  ARTEMIS_SOURCE_DIR         Local source root used with --local-source (default: Source)");
  console.log(`  ZENODO_RECORD              Default source record id (default: ${DEFAULT_ZENODO_RECORD})`);
  console.log("  ZENODO_TOKEN               Zenodo personal access token; required only if ZENODO_RECORD turns out to be an unpublished draft (auto-detected)");
  console.log("  BUILD_CONCURRENCY          Concurrent manifest/source workers (default: CPU-capped at 8)");
  console.log("  PARCEL_SIMPLIFY_EPSILON    Parcel Douglas-Peucker epsilon; pixels when pixel_geometry exists (default: 5)");
  console.log("  IIIF_LIMIT                 Process first N IIIF manifests per source for test runs");
  console.log("  IIIF_SPRITE_SIZE           Long edge of generated IIIF sprites in px (default: 256)");
  console.log("  IIIF_MASK_SIMPLIFY_EPSILON Resource-mask simplification epsilon in image pixels (default: 5.5)");
  console.log("  RASTER                     Set to 0/false/no to skip the raster warp (same as --no-raster)");
  console.log("  RASTER_FETCH_WIDTH         Capped IIIF warp-source width in px (default: 1024)");
  console.log("  RASTER_TILE_SIZE           Raster tile size in px (default: 512)");
  console.log("  RASTER_TILE_FORMAT         Raster tile format webp|png|jpeg (default: webp)");
  console.log("  RASTER_MIN_ZOOM/MAX_ZOOM   Raster tile zoom range (default: 8-13; raise fetch width for z14+)");
  console.log("  RASTER_WEBP_QUALITY        WEBP tile quality 1-100 (default: 75)");
  console.log("  BUILD_FORCE                Set to 1/true/yes to bypass the incremental build cache (same as --force)");
}

function optionValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positionalZenodoRecord(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--zenodo-record") {
      index++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    if (/^\d+$/.test(arg)) return arg;
    return undefined;
  }
  return undefined;
}

function isBuildCommand(command: string | undefined): boolean {
  return ["build", "iiif", "toponyms", "parcels", "imagecollections", "layers"].includes(command ?? "");
}

function layerArgs(args: string[], consumePositionalZenodoRecord = false): string[] {
  const layers: string[] = [];
  let consumedPositionalRecord = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--zenodo-record") {
      index++;
      continue;
    }
    if (arg.startsWith("--zenodo-record=")) continue;
    if (arg === "--local-source") continue;
    if (consumePositionalZenodoRecord && !consumedPositionalRecord && /^\d+$/.test(arg)) {
      consumedPositionalRecord = true;
      continue;
    }
    if (!arg.startsWith("-")) layers.push(arg);
  }
  return layers;
}

type ZenodoSourceInfo = { recordId: string; isDraft: boolean };

/**
 * Record id/draft-ness is resolved even under --local-source: sublayer
 * `download:` filenames are checked against the Zenodo record's published
 * files regardless of where the geojson/source content itself is read from,
 * so --local-source only skips the Source.zip sync, not that lookup.
 */
async function applyZenodoSource(args: string[]): Promise<ZenodoSourceInfo> {
  const recordId = optionValue(args, "--zenodo-record") ?? process.env.ZENODO_RECORD ?? positionalZenodoRecord(args) ?? DEFAULT_ZENODO_RECORD;
  let isDraft: boolean;
  if (args.includes("--local-source")) {
    log.ok(`using local source: ${sourceDir()}`);
    isDraft = await detectZenodoDraftStatus(recordId, process.env.ZENODO_TOKEN);
  } else {
    const synced = await syncZenodoSource(recordId, { token: process.env.ZENODO_TOKEN });
    setSourceDir(synced.sourceDir);
    isDraft = synced.isDraft;
  }
  // Written so CI can route the output branch/release without re-detecting draft-ness itself.
  await writeJson(BUILD_ZENODO_SOURCE_PATH, { recordId, isDraft });
  return { recordId, isDraft };
}

/** Unresolved sublayer downloads/logos must block publishing, unlike IIIF warnings - fail the whole command on them. */
function failOnSignificantIssues(result: PublishLayersResult): void {
  const issues = significantIssues(result);
  if (issues.length === 0) return;
  throw new Error(`${issues.length} unresolved reference(s) block publishing:\n  - ${issues.join("\n  - ")}`);
}

function iiifLimit(): number | undefined {
  const parsed = Number.parseInt(process.env.IIIF_LIMIT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Raster warp runs by default; `--no-raster` or RASTER=0 skips it (geomaps+sprites only). */
function rasterEnabled(args: string[]): boolean {
  if (args.includes("--no-raster")) return false;
  return !/^(0|false|no)$/i.test(process.env.RASTER ?? "");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const selectedLayerIds = layerArgs(args, isBuildCommand(command) && !args.includes("--local-source"));
  const raster = rasterEnabled(args);
  const force = args.includes("--force") || buildForceEnabled();
  const buildLog = new BuildLog();
  const registry = new HashRegistry(force);
  if (force) log.info("  ! --force: rebuilding everything (incremental cache bypassed)");

  switch (command) {
    case "build": {
      const zenodoSource = await applyZenodoSource(args);
      await buildLog.reset("build", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      log.step(`Building data artifacts (${workerCount} workers)`);
      await buildLog.fields({ workers: workerCount, raster: raster ? "yes" : "no", force: force ? "yes" : "no", source: sourceDir(), "zenodo record": zenodoSource?.recordId });
      await buildLog.timed("iiif", () => buildIiif({ layers, concurrency: workerCount, limit: iiifLimit(), raster, buildLog, registry }));
      await buildLog.timed("toponyms", () => buildToponyms({ layers, concurrency: workerCount, buildLog, registry }));
      await buildLog.timed("parcels", () => buildParcels({ layers, concurrency: workerCount, buildLog, registry }));
      await buildLog.timed("imagecollections", () => buildImageCollections({ concurrency: workerCount, buildLog, force }));
      // Registry last: it scans build/Layers/<id>/ for each layer's produced artifacts.
      const buildLayersResult = await buildLog.timed("layers", () => publishLayers({ buildLog, force, zenodoRecordId: zenodoSource?.recordId, isDraft: zenodoSource?.isDraft }));
      await registry.flushAll();
      failOnSignificantIssues(buildLayersResult);
      break;
    }
    case "iiif": {
      const zenodoSource = await applyZenodoSource(args);
      await buildLog.reset("iiif", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      await buildLog.fields({ workers: workerCount, limit: iiifLimit(), raster: raster ? "yes" : "no", force: force ? "yes" : "no", source: sourceDir(), "zenodo record": zenodoSource?.recordId });
      await buildLog.timed("iiif", () => buildIiif({ layers, concurrency: workerCount, limit: iiifLimit(), raster, buildLog, registry }));
      await registry.flushAll();
      break;
    }
    case "toponyms": {
      const zenodoSource = await applyZenodoSource(args);
      await buildLog.reset("toponyms", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      await buildLog.fields({ workers: workerCount, source: sourceDir(), "zenodo record": zenodoSource?.recordId });
      await buildLog.timed("toponyms", () => buildToponyms({ layers, concurrency: workerCount, buildLog, registry }));
      await registry.flushAll();
      break;
    }
    case "parcels": {
      const zenodoSource = await applyZenodoSource(args);
      await buildLog.reset("parcels", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      await buildLog.fields({ workers: workerCount, source: sourceDir(), "zenodo record": zenodoSource?.recordId });
      await buildLog.timed("parcels", () => buildParcels({ layers, concurrency: workerCount, buildLog, registry }));
      await registry.flushAll();
      break;
    }
    case "imagecollections": {
      const zenodoSource = await applyZenodoSource(args);
      await buildLog.reset("imagecollections", selectedLayerIds);
      const workerCount = concurrency();
      await buildLog.fields({ workers: workerCount, force: force ? "yes" : "no", source: sourceDir(), "zenodo record": zenodoSource?.recordId });
      await buildLog.timed("imagecollections", () => buildImageCollections({ selectedIds: selectedLayerIds, concurrency: workerCount, buildLog, force }));
      break;
    }
    case "layers": {
      const zenodoSource = await applyZenodoSource(args);
      await buildLog.reset("layers", selectedLayerIds);
      if (selectedLayerIds.length > 0) log.warn("layers publishes the full registry; ignoring layer id filter");
      await buildLog.fields({ source: sourceDir(), "zenodo record": zenodoSource?.recordId });
      const layersResult = await buildLog.timed("layers", () => publishLayers({ buildLog, force, zenodoRecordId: zenodoSource?.recordId, isDraft: zenodoSource?.isDraft }));
      failOnSignificantIssues(layersResult);
      break;
    }
    case "source:sync": {
      const recordId = selectedLayerIds[0] ?? optionValue(args, "--zenodo-record") ?? process.env.ZENODO_RECORD ?? DEFAULT_ZENODO_RECORD;
      await syncZenodoSource(recordId, { token: process.env.ZENODO_TOKEN });
      break;
    }
    case "source:draft-files": {
      const draftId = selectedLayerIds[0] ?? optionValue(args, "--zenodo-record") ?? process.env.ZENODO_RECORD ?? DEFAULT_ZENODO_RECORD;
      const token = process.env.ZENODO_TOKEN;
      if (!token) throw new Error("ZENODO_TOKEN is required to list draft files");
      const files = await listDraftFiles(draftId, token);
      log.ok(`draft ${draftId}`);
      if (files.length === 0) {
        log.warn("  (no files in this draft)");
      } else {
        for (const file of files) {
          log.info(`  ${file.key}  ${(file.size ?? 0).toLocaleString()} bytes  ${file.checksum ?? "no checksum"}`);
        }
      }
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      help();
      process.exit(1);
  }
}

main().catch(async (err) => {
  try {
    await new BuildLog().error("pipeline failed", err);
  } catch {
    // Avoid hiding the original failure if Build.log cannot be written.
  }
  console.error(err);
  process.exit(1);
});
