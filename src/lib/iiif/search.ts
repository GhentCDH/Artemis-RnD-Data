import type { ProcessedManifest } from "./types";

export type IiifSearchItem = {
  id: string;
  type: "iiif-map";
  layerId: string;
  label: string;
  manifestUrl: string;
  lon?: number;
  lat?: number;
  bounds?: [number, number, number, number];
  canvasCount: number;
  isVerzamelblad: boolean;
};

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function geoPoints(manifest: ProcessedManifest): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (const canvas of manifest.canvases) {
    const gcps = Array.isArray(canvas.georeferencedMap.gcps) ? canvas.georeferencedMap.gcps as Array<Record<string, unknown>> : [];
    for (const gcp of gcps) {
      const geo = gcp.geo;
      if (!Array.isArray(geo)) continue;
      const lon = Number(geo[0]);
      const lat = Number(geo[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) points.push([lon, lat]);
    }
  }
  return points;
}

function boundsForPoints(points: Array<[number, number]>): [number, number, number, number] | undefined {
  if (points.length === 0) return undefined;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of points) {
    west = Math.min(west, lon);
    south = Math.min(south, lat);
    east = Math.max(east, lon);
    north = Math.max(north, lat);
  }
  return [west, south, east, north].map(roundCoordinate) as [number, number, number, number];
}

export function buildIiifSearchIndex(layerId: string, layerLabel: string, processed: ProcessedManifest[]): Record<string, unknown> {
  const items: IiifSearchItem[] = processed.map((manifest) => {
    const bounds = boundsForPoints(geoPoints(manifest));
    return {
      id: manifest.manifestAllmapsId,
      type: "iiif-map",
      layerId,
      label: manifest.manifestLabel,
      manifestUrl: manifest.manifestUrl,
      ...(bounds ? {
        lon: roundCoordinate((bounds[0] + bounds[2]) / 2),
        lat: roundCoordinate((bounds[1] + bounds[3]) / 2),
        bounds,
      } : {}),
      canvasCount: manifest.canvases.length,
      isVerzamelblad: manifest.isVerzamelblad,
    };
  });

  items.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

  return {
    generatedAt: new Date().toISOString(),
    layerId,
    layerLabel,
    itemCount: items.length,
    items,
  };
}
