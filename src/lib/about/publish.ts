import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { aboutJsonPath, BUILD_ABOUT_JSON_PATH, BUILD_ATTRIBUTION_LOGOS_DIR, sourceAttributionLogosDir } from "../paths";
import { ensureDir } from "../utils/files";
import { loadLogoRegistry, resolveLogoFile } from "../attribution/logos";
import { log } from "../log";
import type { BuildLog } from "../build/buildLog";

export type PublishAboutOptions = {
  buildLog?: BuildLog;
};

export type PublishAboutResult = {
  logosCopied: number;
  logosResolved: number;
  unknownLogos: string[];
  aboutPublished: boolean;
};

type AboutLogo = { file?: unknown } & Record<string, unknown>;
type AboutConfig = { logos?: AboutLogo[] } & Record<string, unknown>;

const LOGO_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"]);

/** Copies every logo image asset (not the registry/README) into build/attribution-logos/. */
async function copyLogoImages(): Promise<number> {
  const srcDir = sourceAttributionLogosDir();
  let names: string[];
  try {
    names = (await readdir(srcDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && LOGO_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name);
  } catch {
    return 0;
  }
  await ensureDir(BUILD_ATTRIBUTION_LOGOS_DIR);
  await Promise.all(names.map((name) => copyFile(join(srcDir, name), join(BUILD_ATTRIBUTION_LOGOS_DIR, name))));
  return names.length;
}

/**
 * Publishes `about.json` and the attribution-logo image assets it (and every
 * sublayer) reference. `about.json`'s `logos[]` resolves through the exact same
 * registry/shape as a sublayer's `attribution.logos` (see ../attribution/logos)
 * - one registry, one resolver, instead of hand-duplicating each logo's URL
 * and image path.
 */
export async function publishAbout(options: PublishAboutOptions = {}): Promise<PublishAboutResult> {
  const logosCopied = await copyLogoImages();

  const registry = await loadLogoRegistry();
  const unknownLogos = new Set<string>();
  let logosResolved = 0;
  let aboutPublished = false;

  try {
    const about = JSON.parse(await readFile(aboutJsonPath(), "utf-8")) as AboutConfig;
    const resolvedLogos = (about.logos ?? []).map((entry) => {
      if (typeof entry.file !== "string") return entry;
      const resolved = resolveLogoFile(entry.file, registry);
      if (resolved.href) logosResolved++;
      else unknownLogos.add(entry.file);
      return { ...entry, ...resolved };
    });
    const published = { ...about, logos: resolvedLogos };

    await ensureDir(dirname(BUILD_ABOUT_JSON_PATH));
    await writeFile(BUILD_ABOUT_JSON_PATH, `${JSON.stringify(published, null, 2)}\n`, "utf-8");
    aboutPublished = true;
    log.ok(`about: published ${BUILD_ABOUT_JSON_PATH} (${logosCopied} logo image(s) copied to ${BUILD_ATTRIBUTION_LOGOS_DIR})`);
  } catch (error) {
    log.warn(`no about.json published: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const file of unknownLogos) log.warn(`unknown logo '${file}' in about.json not in the logo registry`);

  await options.buildLog?.section("About");
  await options.buildLog?.fields({
    "logo images copied": logosCopied,
    "about logos resolved": logosResolved,
    "unknown about logos": unknownLogos.size > 0 ? [...unknownLogos].join(", ") : undefined,
    "about.json published": aboutPublished ? "yes" : "no",
  });

  return { logosCopied, logosResolved, unknownLogos: [...unknownLogos], aboutPublished };
}
