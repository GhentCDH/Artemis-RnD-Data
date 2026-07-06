#!/usr/bin/env bun
import { buildParcels } from "./lib/parcels/build";
import { buildToponyms } from "./lib/toponyms/build";
import { buildIiif } from "./lib/iiif/build";
import { discoverLayers } from "./lib/layers/discovery";
import { publishLayers } from "./lib/layers/publish";
import { log } from "./lib/log";
import { cpus } from "node:os";
import { BuildLog } from "./lib/build/buildLog";
import { HashRegistry, buildForceEnabled } from "./lib/build/hashRegistry";

const COMMANDS = {
  build: "Build everything (or the given layer ids) into build/",
  iiif: "Build IIIF geomaps and sprites",
  toponyms: "Build Brotli-compressed toponym search JSON",
  parcels: "Build parcel PMTiles",
  layers: "Merge Source/layers/* into build/layers.yaml",
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
  console.log("artemis-data (v2)\n\nUsage:\n  bun run src/cli.ts <command> [layerId...] [--no-raster] [--force]\n\nCommands:");
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${desc}`);
  }
  console.log("\nFlags:");
  console.log("  --no-raster                Skip the raster warp (geomaps + sprites only) for build/iiif");
  console.log("  --force                    Rebuild everything, bypassing the incremental build cache");
  console.log("\nEnvironment:");
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
  console.log("  WRITE_PLAIN_JSON           Also write uncompressed .json next to .json.br (default: false)");
  console.log("  BUILD_FORCE                Set to 1/true/yes to bypass the incremental build cache (same as --force)");
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
  const selectedLayerIds = args.filter((arg) => !arg.startsWith("-"));
  const raster = rasterEnabled(args);
  const force = args.includes("--force") || buildForceEnabled();
  const buildLog = new BuildLog();
  const registry = new HashRegistry(force);
  if (force) log.info("  ! --force: rebuilding everything (incremental cache bypassed)");

  switch (command) {
    case "build": {
      await buildLog.reset("build", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      log.step(`Building data artifacts (${workerCount} workers)`);
      await buildLog.fields({ workers: workerCount, raster: raster ? "yes" : "no", force: force ? "yes" : "no" });
      await buildLog.timed("iiif", () => buildIiif({ layers, concurrency: workerCount, limit: iiifLimit(), raster, buildLog, registry }));
      await buildLog.timed("toponyms", () => buildToponyms({ layers, concurrency: workerCount, buildLog, registry }));
      await buildLog.timed("parcels", () => buildParcels({ layers, concurrency: workerCount, buildLog, registry }));
      // Registry last: it scans build/Layers/<id>/ for each layer's produced artifacts.
      await buildLog.timed("layers", () => publishLayers({ buildLog, force }));
      await registry.flushAll();
      break;
    }
    case "iiif": {
      await buildLog.reset("iiif", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      await buildLog.fields({ workers: workerCount, limit: iiifLimit(), raster: raster ? "yes" : "no", force: force ? "yes" : "no" });
      await buildLog.timed("iiif", () => buildIiif({ layers, concurrency: workerCount, limit: iiifLimit(), raster, buildLog, registry }));
      await registry.flushAll();
      break;
    }
    case "toponyms": {
      await buildLog.reset("toponyms", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      await buildLog.fields({ workers: workerCount });
      await buildLog.timed("toponyms", () => buildToponyms({ layers, concurrency: workerCount, buildLog, registry }));
      await registry.flushAll();
      break;
    }
    case "parcels": {
      await buildLog.reset("parcels", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      await buildLog.fields({ workers: workerCount });
      await buildLog.timed("parcels", () => buildParcels({ layers, concurrency: workerCount, buildLog, registry }));
      await registry.flushAll();
      break;
    }
    case "layers": {
      await buildLog.reset("layers", selectedLayerIds);
      if (selectedLayerIds.length > 0) log.warn("layers publishes the full registry; ignoring layer id filter");
      await buildLog.timed("layers", () => publishLayers({ buildLog, force }));
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
