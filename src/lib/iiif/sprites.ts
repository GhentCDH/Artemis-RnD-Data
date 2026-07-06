import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Image } from "@allmaps/iiif-parser";
import sharp from "sharp";
import { iiifCacheDir } from "../paths";
import { ensureDir, writeJson } from "../utils/files";
import { spriteMaxSize, SPRITESHEET_MAX_WIDTH } from "./config";
import { pathExists } from "./json";
import type { SpritePlacement, SpriteSource } from "./types";

export function calculateSpriteSize(width: number, height: number): { width: number; height: number } {
  const spriteSize = spriteMaxSize();
  const aspect = width / height;
  return width >= height
    ? { width: spriteSize, height: Math.max(1, Math.round(spriteSize / aspect)) }
    : { width: Math.max(1, Math.round(spriteSize * aspect)), height: spriteSize };
}

export async function fetchSprite(serviceUrl: string, info: Record<string, unknown>, spriteSize: { width: number; height: number }, cachePath: string): Promise<Buffer> {
  if (await pathExists(cachePath)) return readFile(cachePath);
  const normalized = serviceUrl.replace(/\/info\.json$/i, "").replace(/\/+$/, "");
  const urls = [
    `${normalized}/full/${spriteSize.width},${spriteSize.height}/0/default.jpg`,
    `${normalized}/full/!${spriteSize.width},${spriteSize.height}/0/default.jpg`,
  ];
  try {
    const parsed = Image.parse(info);
    const request = parsed.getImageRequest(spriteSize);
    if (!Array.isArray(request)) urls.push(parsed.getImageUrl(request));
  } catch {
    // Manual IIIF URLs above cover the common services used here.
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
  throw new Error(`Sprite fetch failed: ${errors.slice(-3).join(" | ")}`);
}

export function packSprites(sprites: SpriteSource[]): { width: number; height: number; placements: SpritePlacement[] } {
  if (sprites.length === 0) return { width: 0, height: 0, placements: [] };
  const totalArea = sprites.reduce((sum, sprite) => sum + sprite.spriteWidth * sprite.spriteHeight, 0);
  const widest = sprites.reduce((max, sprite) => Math.max(max, sprite.spriteWidth), 0);
  const targetWidth = Math.max(widest, Math.min(SPRITESHEET_MAX_WIDTH, Math.ceil(Math.sqrt(totalArea))));
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let width = 0;
  const placements: SpritePlacement[] = [];

  for (const sprite of [...sprites].sort((a, b) => b.spriteHeight - a.spriteHeight)) {
    if (cursorX > 0 && cursorX + sprite.spriteWidth > targetWidth) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    placements.push({ ...sprite, x: cursorX, y: cursorY });
    cursorX += sprite.spriteWidth;
    rowHeight = Math.max(rowHeight, sprite.spriteHeight);
    width = Math.max(width, cursorX);
  }
  return { width, height: cursorY + rowHeight, placements };
}

export async function writeSpriteArtifacts(layerId: string, outDir: string, spriteSources: SpriteSource[]): Promise<{ image: string; json: string; imageSize: [number, number]; count: number } | null> {
  if (spriteSources.length === 0) return null;
  const packed = packSprites(spriteSources);
  await sharp({
    create: { width: packed.width, height: packed.height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite(packed.placements.map((placement) => ({ input: placement.buffer, left: placement.x, top: placement.y })))
    .webp({ quality: 75 })
    .toFile(join(outDir, "sprites.webp"));

  const spritesJson: Record<string, unknown> = {};
  for (const placement of packed.placements) {
    spritesJson[placement.canvasAllmapsId] = {
      imageId: placement.imageId,
      scaleFactor: Math.max(placement.fullWidth / placement.spriteWidth, placement.fullHeight / placement.spriteHeight),
      spriteTileScale: spriteMaxSize() / 256,
      x: placement.x,
      y: placement.y,
      width: placement.spriteWidth,
      height: placement.spriteHeight,
    };
  }
  await writeJson(join(outDir, "sprites.json"), spritesJson, true);
  return { image: `Layers/${layerId}/sprites.webp`, json: `Layers/${layerId}/sprites.json`, imageSize: [packed.width, packed.height], count: packed.placements.length };
}

export function spriteCachePath(layerId: string, canvasAllmapsId: string, size: { width: number; height: number }): string {
  return join(iiifCacheDir("sprites"), layerId, `${canvasAllmapsId}_${size.width}x${size.height}.jpg`);
}
