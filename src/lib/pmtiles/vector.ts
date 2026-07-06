import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { ensureDir } from "../utils/files";
import { runCommand } from "../utils/run";

export type VectorPmtilesOptions = {
  inputGeojson: string;
  outputPmtiles: string;
  tmpDir: string;
  layerName: string;
  minZoom?: number;
  maxZoom?: number;
  buffer?: number;
};

const DEFAULT_VECTOR_TILE_BUFFER = 64;

export function vectorTileBuffer(): number {
  const parsed = Number.parseInt(process.env.VECTOR_TILE_BUFFER ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_VECTOR_TILE_BUFFER;
}

export async function buildVectorPmtiles(options: VectorPmtilesOptions): Promise<void> {
  const minZoom = options.minZoom ?? 0;
  const maxZoom = options.maxZoom ?? 14;
  const buffer = options.buffer ?? vectorTileBuffer();
  const mbtilesPath = join(options.tmpDir, `${basename(options.outputPmtiles, ".pmtiles")}.mbtiles`);

  await ensureDir(options.tmpDir);
  await rm(mbtilesPath, { force: true });
  await rm(options.outputPmtiles, { force: true });

  await runCommand("tippecanoe", [
    "--force",
    "--no-tile-compression",
    "--minimum-zoom",
    String(minZoom),
    "--maximum-zoom",
    String(maxZoom),
    "--buffer",
    String(buffer),
    "--layer",
    options.layerName,
    "--output",
    mbtilesPath,
    options.inputGeojson,
  ]);

  await runCommand("pmtiles", ["convert", mbtilesPath, options.outputPmtiles]);
  await rm(mbtilesPath, { force: true });
}
