import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Image } from "@allmaps/iiif-parser";
import { iiifCacheDir } from "../paths";
import { ensureDir } from "../utils/files";
import { pathExists } from "../iiif/json";

/*
 * Fetch a capped-resolution IIIF image to warp. This is a larger fetch than the
 * thumbnail sprite (~1024px vs 256px) but still the low-res IIIF endpoint — never
 * a full-resolution dezoomify download. Cached on disk keyed by service + width.
 */

export function warpSourceCachePath(serviceId: string, width: number): string {
  const normalized = serviceId.replace(/\/info\.json$/i, "").replace(/\/+$/, "");
  const key = Buffer.from(normalized).toString("base64url");
  return join(iiifCacheDir("warp"), `${key}_${width}.jpg`);
}

export async function fetchWarpSource(
  serviceId: string,
  info: Record<string, unknown> | null,
  width: number,
  cachePath: string,
): Promise<Buffer> {
  if (await pathExists(cachePath)) return readFile(cachePath);
  const normalized = serviceId.replace(/\/info\.json$/i, "").replace(/\/+$/, "");
  const srcWidth = Number(info?.width);

  // If the source is already narrower than the cap, ask for "max" instead of upscaling.
  const size = Number.isFinite(srcWidth) && srcWidth > 0 && srcWidth <= width ? "max" : `${width},`;
  const urls = [
    `${normalized}/full/${size}/0/default.jpg`,
    `${normalized}/full/${width},/0/default.jpg`,
  ];
  if (info) {
    try {
      const parsed = Image.parse(info);
      const request = parsed.getImageRequest({ width, height: width });
      if (!Array.isArray(request)) urls.push(parsed.getImageUrl(request));
    } catch {
      // The manual IIIF URLs above cover the services used here.
    }
  }

  const errors: string[] = [];
  for (const url of [...new Set(urls)]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          errors.push(`${res.status} ${url}`);
          if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 3) await Bun.sleep(250 * attempt);
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        await ensureDir(dirname(cachePath));
        await writeFile(cachePath, buffer);
        return buffer;
      } catch (err) {
        errors.push(`${err instanceof Error ? err.message : String(err)} ${url}`);
        if (attempt < 3) await Bun.sleep(250 * attempt);
      }
    }
  }
  throw new Error(`Warp source fetch failed: ${errors.slice(-3).join(" | ")}`);
}
