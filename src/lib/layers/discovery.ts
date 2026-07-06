import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { sourceLayersDir } from "../paths";

export type LayerConfig = {
  id: string;
  label: string;
  timeframe?: unknown;
  sublayers?: Array<{
    id: string;
    name?: string;
    kind?: string;
    source?: {
      type?: string;
      rawInput?: string;
      url?: string;
    };
  }>;
};

export type LayerRef = {
  id: string;
  label: string;
  dir: string;
  configPath: string;
  config: LayerConfig;
};

function isLayerConfig(value: unknown): value is LayerConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { label?: unknown }).label === "string"
  );
}

export async function discoverLayers(layerIds?: string[]): Promise<LayerRef[]> {
  const wanted = new Set((layerIds ?? []).filter(Boolean));
  const root = sourceLayersDir();
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => wanted.size === 0 || wanted.has(name))
    .sort((a, b) => a.localeCompare(b));

  const layers: LayerRef[] = [];
  for (const dirName of dirs) {
    const dir = join(root, dirName);
    const configPath = join(dir, `${dirName}.yaml`);
    const config = YAML.parse(await readFile(configPath, "utf-8")) as unknown;
    if (!isLayerConfig(config)) throw new Error(`${configPath} is not a valid layer config`);
    layers.push({ id: config.id, label: config.label, dir, configPath, config });
  }

  return layers;
}
