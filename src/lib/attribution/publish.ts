import { copyFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { BuildLog } from "../build/buildLog";
import { log } from "../log";
import { BUILD_ATTRIBUTION_LOGOS_DIR, sourceAttributionLogosDir } from "../paths";
import { ensureDir } from "../utils/files";

export type PublishAttributionAssetsOptions = {
  buildLog?: BuildLog;
};

export type PublishAttributionAssetsResult = {
  logosCopied: number;
};

const LOGO_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"]);

/** Copies shared attribution logo images into build/attribution-logos/. */
export async function publishAttributionAssets(
  options: PublishAttributionAssetsOptions = {},
): Promise<PublishAttributionAssetsResult> {
  const srcDir = sourceAttributionLogosDir();
  let names: string[];
  try {
    names = (await readdir(srcDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && LOGO_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name);
  } catch {
    names = [];
  }

  if (names.length > 0) {
    await ensureDir(BUILD_ATTRIBUTION_LOGOS_DIR);
    await Promise.all(names.map((name) => copyFile(join(srcDir, name), join(BUILD_ATTRIBUTION_LOGOS_DIR, name))));
  }

  log.ok(`attribution: copied ${names.length} logo image(s) to ${BUILD_ATTRIBUTION_LOGOS_DIR}`);
  await options.buildLog?.section("Attribution assets");
  await options.buildLog?.fields({ "logo images copied": names.length });
  return { logosCopied: names.length };
}
