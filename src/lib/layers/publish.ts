import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import YAML from "yaml";
import { discoverLayers } from "./discovery";
import { BUILD_LAYERS_YAML_PATH, layerOutDir, logosRegistryPath } from "../paths";
import { ensureDir } from "../utils/files";
import { stableStringify } from "../utils/hash";
import { log } from "../log";
import type { BuildLog } from "../build/buildLog";

/** Bump to invalidate the merged layers.yaml when the merge/resolution changes. */
const LAYERS_RECIPE = 5;

/**
 * Published per-layer artifact filenames → the registry key the viewer looks up.
 * Only these canonical outputs are registered (debug `.json` twins are ignored);
 * paths in layers.yaml are relative to the deploy root, i.e. `Layers/<id>/<file>`.
 */
const ARTIFACT_KEYS: Record<string, string> = {
  "geomaps.json": "geomaps",
  "search.json": "search",
  "raster.pmtiles": "raster",
  "masks.pmtiles": "masks",
  "parcels.pmtiles": "parcels",
  "sprites.jpg": "sprites",
  "sprites.webp": "sprites",
  "sprites.json": "spritesIndex",
  "toponyms.json": "toponyms",
};

export type PublishLayersOptions = {
  buildLog?: BuildLog;
  force?: boolean;
};

export type PublishLayersResult = {
  layers: number;
  sublayers: number;
  logosResolved: number;
  unknownLogos: string[];
  outputPath: string;
  cached?: boolean;
};

/**
 * Logo registry (`logos.yaml`) is a flat `filename: click-through-url` map. A
 * sublayer's `attribution.logos` lists filenames from it; publishing resolves
 * each filename to `{ file, href }` so the viewer needs no second lookup.
 */
async function loadLogoRegistry(): Promise<Map<string, string>> {
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

type MutableSublayer = {
  id?: string;
  name?: string;
  kind?: string;
  source?: { rawInput?: string };
  attribution?: { logos?: unknown };
  artifacts?: Record<string, string>;
};

type MutableLayer = {
  sublayers?: MutableSublayer[];
};

/** IIIF sublayers own the georeferenced/raster artifacts; each is a single build output. */
const IIIF_ARTIFACT_KEYS = ["geomaps", "search", "raster", "masks", "sprites", "spritesIndex"];

/**
 * Which registry keys a sublayer produces, by kind/source — so artifacts attach
 * to the sublayer that generated them, not the whole layer. (Mirrors the build's
 * own sublayer detection in parcels/toponyms.)
 */
function ownedArtifactKeys(sublayer: MutableSublayer): string[] {
  const kind = (sublayer.kind ?? "").toLowerCase();
  const rawInput = sublayer.source?.rawInput ?? "";
  const id = (sublayer.id ?? "").toLowerCase();
  const name = (sublayer.name ?? "").toLowerCase();
  if (kind === "iiif") return IIIF_ARTIFACT_KEYS;
  if (kind === "searchable" || rawInput.startsWith("toponyms/")) return ["toponyms"];
  if (rawInput.startsWith("parcels/") || id.includes("parcel") || name.includes("parcel")) return ["parcels"];
  return [];
}

/**
 * Scans a layer's published output dir and maps the recognized artifacts to
 * deploy-root-relative paths, so layers.yaml doubles as the file registry (which
 * built file belongs to which layer). Absent files are simply omitted, so the
 * registry reflects exactly what was produced.
 */
async function scanArtifacts(layerId: string): Promise<Record<string, string>> {
  let names: string[];
  try {
    names = (await readdir(layerOutDir(layerId), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return {};
  }
  const artifacts: Record<string, string> = {};
  for (const name of names.sort()) {
    const key = ARTIFACT_KEYS[name];
    if (key) artifacts[key] = `Layers/${layerId}/${name}`;
  }
  return artifacts;
}

/** Replaces each sublayer's `logos: [filename]` with `[{ file, href }]` in place. */
function resolveLogos(layer: MutableLayer, registry: Map<string, string>, unknown: Set<string>): number {
  let resolved = 0;
  for (const sublayer of layer.sublayers ?? []) {
    const logos = sublayer.attribution?.logos;
    if (!Array.isArray(logos)) continue;
    sublayer.attribution!.logos = logos.map((file) => {
      if (typeof file !== "string") return file;
      const href = registry.get(file);
      if (href) resolved++;
      else unknown.add(file);
      return href ? { file, href } : { file };
    });
  }
  return resolved;
}

/**
 * Merges every `Source/layers/<LayerId>/<LayerId>.yaml` into a single
 * `build/layers.yaml` the viewer fetches. Always publishes all layers so the
 * registry stays complete regardless of any per-layer build selection.
 */
export async function publishLayers(options: PublishLayersOptions = {}): Promise<PublishLayersResult> {
  const refs = await discoverLayers();
  const registry = await loadLogoRegistry();
  const unknownLogos = new Set<string>();
  let sublayers = 0;
  let logosResolved = 0;

  const layers = await Promise.all(
    refs.map(async (ref) => {
      const config = structuredClone(ref.config) as MutableLayer;
      sublayers += config.sublayers?.length ?? 0;
      logosResolved += resolveLogos(config, registry, unknownLogos);

      // Attach each produced artifact to the sublayer that owns it, so two
      // sublayers of the same kind stay individually resolvable.
      const scanned = await scanArtifacts(ref.id);
      for (const sublayer of config.sublayers ?? []) {
        const artifacts: Record<string, string> = {};
        for (const key of ownedArtifactKeys(sublayer)) {
          if (scanned[key]) artifacts[key] = scanned[key];
        }
        if (Object.keys(artifacts).length > 0) sublayer.artifacts = artifacts;
      }
      return config;
    }),
  );

  if (!options.force) {
    try {
      const current = YAML.parse(await readFile(BUILD_LAYERS_YAML_PATH, "utf-8")) as { buildRecipe?: unknown; layers?: unknown };
      if (current?.buildRecipe === LAYERS_RECIPE && stableStringify(current?.layers) === stableStringify(layers)) {
        log.ok(`layers: unchanged — skipped (${BUILD_LAYERS_YAML_PATH})`);
        return { layers: layers.length, sublayers, logosResolved, unknownLogos: [...unknownLogos], outputPath: BUILD_LAYERS_YAML_PATH, cached: true };
      }
    } catch {
      // Missing or invalid output: rewrite below.
    }
  }

  const header =
    "# build/layers.yaml — merged viewer layer config + published-file registry.\n" +
    "# Generated by `bun run src/cli.ts layers` (runs last in a build); do not edit by hand.\n" +
    "# Config source of truth: Source/layers/<LayerId>/<LayerId>.yaml\n" +
    "# Each sublayer's `artifacts` maps role -> deploy-relative path under Layers/<LayerId>/.\n";
  const body = YAML.stringify({ generatedAt: new Date().toISOString(), buildRecipe: LAYERS_RECIPE, layers }, { lineWidth: 0 });

  await ensureDir(dirname(BUILD_LAYERS_YAML_PATH));
  await writeFile(BUILD_LAYERS_YAML_PATH, `${header}${body}`, "utf-8");

  log.ok(`layers: ${layers.length} layers, ${sublayers} sublayers → ${BUILD_LAYERS_YAML_PATH}`);
  const registryPath = logosRegistryPath();
  for (const file of unknownLogos) log.warn(`unknown logo '${file}' not in ${registryPath}`);

  await options.buildLog?.section("Layers");
  await options.buildLog?.fields({
    layers: layers.length,
    sublayers,
    "logos resolved": logosResolved,
    "unknown logos": unknownLogos.size > 0 ? [...unknownLogos].join(", ") : undefined,
    output: BUILD_LAYERS_YAML_PATH,
  });

  return {
    layers: layers.length,
    sublayers,
    logosResolved,
    unknownLogos: [...unknownLogos],
    outputPath: BUILD_LAYERS_YAML_PATH,
  };
}
