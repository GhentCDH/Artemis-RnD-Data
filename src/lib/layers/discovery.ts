import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { sourceLayersDir } from "../paths";
import { parseLayerConfig, type LayerConfig } from "../sourceValidation";

export type LayerRef = {
  id: string;
  label: string;
  dir: string;
  configPath: string;
  config: LayerConfig;
};

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
    const config = parseLayerConfig(YAML.parse(await readFile(configPath, "utf-8")) as unknown, configPath);
    layers.push({ id: config.id, label: config.label, dir, configPath, config });
  }

  return layers;
}
