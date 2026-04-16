import { readFile } from "node:fs/promises";

export type SourceRegistryEntry = {
  id: string;
  family: "iiif layers" | "image collections" | "service layers";
  kind: "iiif" | "wmts" | "wms" | "wfs";
  label: string;
  url: string;
  timeframe?: {
    label: string;
    startYear?: number | null;
    endYear?: number | null;
  };
};

type SourceRegistryFile = {
  version: number;
  mainLayerOrder?: string[];
  mainLayers?: Array<{
    id: string;
    label: string;
    timeframe?: SourceRegistryEntry["timeframe"];
    sublayers?: Array<{
      id: string;
      label: string;
      kind: "iiif" | "wmts" | "wms" | "wfs" | "geojson" | "searchable";
      source?: {
        url?: string;
      };
    }>;
  }>;
  imageCollections?: Array<{
    id: string;
    label: string;
    kind: "iiif";
    source?: {
      url?: string;
    };
  }>;
};

export async function readSourceRegistry(
  path = "data/sources/registry.json"
): Promise<SourceRegistryFile> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as SourceRegistryFile;

  if (!Array.isArray(parsed.mainLayers)) {
    throw new Error(`Invalid source registry: missing mainLayers[] in ${path}`);
  }

  return parsed;
}

export function iiifSourceUrls(registry: SourceRegistryFile): string[] {
  const mainLayerUrls = (registry.mainLayers ?? [])
    .flatMap((layer) => layer.sublayers ?? [])
    .filter((sublayer) => sublayer.kind === "iiif")
    .map((sublayer) => sublayer.source?.url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);

  const imageCollectionUrls = (registry.imageCollections ?? [])
    .filter((entry) => entry.kind === "iiif")
    .map((entry) => entry.source?.url)
    .filter((url): url is string => typeof url === "string" && url.length > 0);

  return [...mainLayerUrls, ...imageCollectionUrls];
}
