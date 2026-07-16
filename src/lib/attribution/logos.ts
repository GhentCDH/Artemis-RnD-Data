import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { logosRegistryPath } from "../paths";
import { log } from "../log";

export type ResolvedLogo = { file: string; href?: string; src: string };

/**
 * Logo registry (`attribution-logos/logos.yaml`): flat filename -> click-through
 * URL. The single source of truth for what an attribution logo links to.
 */
export async function loadLogoRegistry(): Promise<Map<string, string>> {
  const registryPath = logosRegistryPath();
  try {
    const parsed = YAML.parse(await readFile(registryPath, "utf-8")) as Record<string, unknown> | null;
    const registry = new Map<string, string>();
    for (const [file, href] of Object.entries(parsed ?? {})) {
      if (typeof href === "string") registry.set(file, href);
    }
    return registry;
  } catch {
    log.warn(`no logo registry at ${registryPath}; leaving logo filenames unresolved`);
    return new Map();
  }
}

/**
 * Resolves a logo filename to its click-through URL and published image path -
 * the shape every sublayer logo reference resolves to, so callers never need a
 * second lookup to find where the image actually lives.
 */
export function resolveLogoFile(file: string, registry: Map<string, string>): ResolvedLogo {
  const href = registry.get(file);
  return href ? { file, href, src: `attribution-logos/${file}` } : { file, src: `attribution-logos/${file}` };
}
