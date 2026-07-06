import { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/*
 * Pack a gdal2tiles `--xyz` tile tree ({z}/{x}/{y}.<ext>) into a raster MBTiles
 * archive. go-pmtiles only converts MBTiles (not loose tile directories), so this
 * is the bridge between gdal2tiles output and `pmtiles convert`. Written with the
 * built-in bun:sqlite so no extra runtime/tooling is needed.
 */

export type XyzToMbtilesResult = { tileCount: number; minZoom: number; maxZoom: number; format: string };

const FORMAT_BY_EXT: Record<string, string> = { webp: "webp", png: "png", jpg: "jpeg", jpeg: "jpeg" };

function tile2lon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

function tile2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

async function numericSubdirs(dir: string): Promise<number[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => Number(entry.name)).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function xyzDirToMbtiles(xyzDir: string, mbtilesPath: string, options: { name?: string } = {}): Promise<XyzToMbtilesResult> {
  const zooms = await numericSubdirs(xyzDir);
  if (zooms.length === 0) throw new Error(`no numeric zoom directories found in ${xyzDir}`);

  const db = new Database(mbtilesPath, { create: true });
  db.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;");
  db.exec("CREATE TABLE metadata (name TEXT, value TEXT);");
  db.exec("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);");
  db.exec("CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);");
  const insertTile = db.prepare("INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)");

  let tileCount = 0;
  let format = "webp";
  let west = 180;
  let south = 85.0511;
  let east = -180;
  let north = -85.0511;

  const insertAll = db.transaction(async () => {
    for (const z of zooms) {
      const zDir = join(xyzDir, String(z));
      for (const x of await numericSubdirs(zDir)) {
        const xDir = join(zDir, String(x));
        let files: string[];
        try {
          files = await readdir(xDir);
        } catch {
          continue;
        }
        for (const file of files) {
          const match = file.match(/^(\d+)\.(\w+)$/);
          if (!match) continue;
          const y = Number(match[1]);
          format = FORMAT_BY_EXT[match[2]!.toLowerCase()] ?? format;
          const data = await readFile(join(xDir, file));
          // gdal2tiles --xyz writes XYZ y; MBTiles stores TMS row.
          const tmsRow = 2 ** z - 1 - y;
          insertTile.run(z, x, tmsRow, data);
          tileCount++;
          west = Math.min(west, tile2lon(x, z));
          east = Math.max(east, tile2lon(x + 1, z));
          north = Math.max(north, tile2lat(y, z));
          south = Math.min(south, tile2lat(y + 1, z));
        }
      }
    }
  });
  await insertAll();

  const minZoom = zooms[0]!;
  const maxZoom = zooms[zooms.length - 1]!;
  const centerLon = (west + east) / 2;
  const centerLat = (south + north) / 2;
  const metadata: Record<string, string> = {
    name: options.name ?? "raster",
    format,
    type: "baselayer",
    minzoom: String(minZoom),
    maxzoom: String(maxZoom),
    bounds: [west, south, east, north].map((value) => value.toFixed(6)).join(","),
    center: `${centerLon.toFixed(6)},${centerLat.toFixed(6)},${minZoom}`,
  };
  const insertMeta = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(metadata)) insertMeta.run(key, value);

  db.close();
  if (tileCount === 0) throw new Error(`no tiles found under ${xyzDir}`);
  return { tileCount, minZoom, maxZoom, format };
}
