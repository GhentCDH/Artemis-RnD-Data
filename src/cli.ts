#!/usr/bin/env bun
import { buildParcels } from "./lib/parcels/build";
import { buildToponyms } from "./lib/toponyms/build";
import { buildIiif } from "./lib/iiif/build";
import { discoverLayers } from "./lib/layers/discovery";
import { log } from "./lib/log";
import { cpus } from "node:os";
import { BuildLog } from "./lib/build/buildLog";
import { buildRasterPmtiles } from "./lib/pmtiles/raster";
import { layerOutDir } from "./lib/paths";
import { join } from "node:path";

const COMMANDS = {
  build: "Build everything (or the given layer ids) into build/",
  iiif: "Build IIIF geomaps and sprites",
  toponyms: "Build Brotli-compressed toponym search JSON",
  parcels: "Build parcel PMTiles",
  "pack-raster": "Pack an existing XYZ raster tile directory into Layers/<layerId>/raster.pmtiles",
  layers: "Merge Source/layers/* into build/layers.yaml",
  help: "Show this help",
} as const;

function concurrency(): number {
  const parsed = Number.parseInt(process.env.BUILD_CONCURRENCY ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(1, Math.min(8, cpus().length || 4));
}

function help(): void {
  console.log("artemis-data (v2)\n\nUsage:\n  bun run src/index.ts <command> [layerId...] [--no-raster]\n\nCommands:");
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${desc}`);
  }
  console.log("\nFlags:");
  console.log("  --no-raster                Skip the raster warp (geomaps + sprites only) for build/iiif");
  console.log("\nManual raster packing (pack an existing XYZ tile tree):");
  console.log("  bun run src/index.ts pack-raster <layerId> <xyzTilesDir>");
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
  const buildLog = new BuildLog();

  switch (command) {
    case "build": {
      await buildLog.reset("build", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      log.step(`Building data artifacts (${workerCount} workers)`);
      await buildLog.fields({ workers: workerCount, raster: raster ? "yes" : "no" });
      await buildLog.timed("iiif", () => buildIiif({ layers, concurrency: workerCount, limit: iiifLimit(), raster, buildLog }));
      await buildLog.timed("toponyms", () => buildToponyms({ layers, concurrency: workerCount, buildLog }));
      await buildLog.timed("parcels", () => buildParcels({ layers, concurrency: workerCount, buildLog }));
      break;
    }
    case "iiif": {
      await buildLog.reset("iiif", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      await buildLog.fields({ workers: workerCount, limit: iiifLimit(), raster: raster ? "yes" : "no" });
      await buildLog.timed("iiif", () => buildIiif({ layers, concurrency: workerCount, limit: iiifLimit(), raster, buildLog }));
      break;
    }
    case "toponyms": {
      await buildLog.reset("toponyms", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      await buildLog.fields({ workers: workerCount });
      await buildLog.timed("toponyms", () => buildToponyms({ layers, concurrency: workerCount, buildLog }));
      break;
    }
    case "parcels": {
      await buildLog.reset("parcels", selectedLayerIds);
      const layers = await discoverLayers(selectedLayerIds);
      const workerCount = concurrency();
      await buildLog.fields({ workers: workerCount });
      await buildLog.timed("parcels", () => buildParcels({ layers, concurrency: workerCount, buildLog }));
      break;
    }
    case "pack-raster": {
      const [layerId, tilesDir] = selectedLayerIds;
      if (!layerId || !tilesDir) {
        console.error("Usage: bun run src/index.ts pack-raster <layerId> <xyzTilesDir>");
        process.exit(1);
      }
      await buildLog.reset("pack-raster", selectedLayerIds);
      const outputPmtiles = join(layerOutDir(layerId), "raster.pmtiles");
      await buildLog.timed("pack-raster", () => buildRasterPmtiles({ inputTilesDir: tilesDir, outputPmtiles }));
      await buildLog.fields({ layer: layerId, input: tilesDir, output: outputPmtiles });
      log.ok(`${layerId}: packed raster PMTiles -> ${outputPmtiles}`);
      break;
    }
    case "layers":
      console.log("[layers] TODO — enumerate Source/layers/*, resolve logos, emit build/layers.yaml");
      break;
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
