import { basename, extname } from "node:path";
import { centroidForGeometry, isMultiPolygonGeometry, isPolygonGeometry } from "../geojson/geometry";
import type { Feature, FeatureCollection, Geometry, PointGeometry } from "../geojson/types";
import { sha1Short } from "../utils/hash";

export type ToponymItem = {
  id: string;
  text: string;
  lon: number;
  lat: number;
  map: string;
  sheet?: string;
};

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function cleanToponymText(value: unknown): string | null {
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  if (/^\d+$/.test(text)) return null;
  if (/^[^a-zA-Z0-9\s]+$/.test(text)) return null;
  if (/^[-_:,;.!?'"]+|[-_:,;.!?'"]+$/.test(text)) return null;
  if (/#/.test(text)) return null;
  if (/(.)\1{3,}/.test(text)) return null;

  const specialCharCount = (text.match(/[^a-zA-Z0-9\s]/g) ?? []).length;
  if (specialCharCount > text.length * 0.2) return null;

  return text;
}

export function deriveSheetFromSourceFile(sourceFile: string): string | undefined {
  const fileBase = basename(sourceFile, extname(sourceFile));
  const [, sheet] = fileBase.split("_");
  return sheet && /^\d+/.test(sheet) ? sheet : undefined;
}

export function toponymItemsFromFeatureCollection(
  geojson: FeatureCollection,
  mapId: string,
  sourceFile: string,
): ToponymItem[] {
  const sheet = deriveSheetFromSourceFile(sourceFile);
  const items: ToponymItem[] = [];

  geojson.features.forEach((feature, featureIndex) => {
    if (feature.type !== "Feature" || !feature.geometry) return;
    const geometry = feature.geometry as Geometry;
    if (geometry.type !== "Point" && !isPolygonGeometry(geometry) && !isMultiPolygonGeometry(geometry)) return;

    const text = cleanToponymText(feature.properties?.text ?? feature.properties?.title);
    if (!text) return;

    const center = centroidForGeometry(geometry);
    if (!center) return;

    const id = sha1Short(`${sourceFile}:${featureIndex}:${text}`);
    items.push({
      id,
      text,
      lon: roundCoordinate(center[0]),
      lat: roundCoordinate(center[1]),
      map: mapId,
      ...(sheet ? { sheet } : {}),
    });
  });

  return items;
}

export function toponymPointFeatures(items: ToponymItem[]): FeatureCollection<Record<string, unknown>, PointGeometry> {
  const features: Array<Feature<Record<string, unknown>, PointGeometry>> = items.map((item) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [item.lon, item.lat] },
    properties: {
      id: item.id,
      text: item.text,
      map: item.map,
      ...(item.sheet ? { sheet: item.sheet } : {}),
    },
  }));

  return { type: "FeatureCollection", features };
}
