import type { Geometry, MultiPolygonGeometry, PolygonGeometry, Position } from "./types";

export function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

export function isPolygonGeometry(value: unknown): value is PolygonGeometry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "Polygon" &&
    Array.isArray((value as { coordinates?: unknown }).coordinates)
  );
}

export function isMultiPolygonGeometry(value: unknown): value is MultiPolygonGeometry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "MultiPolygon" &&
    Array.isArray((value as { coordinates?: unknown }).coordinates)
  );
}

export function polygonPositions(geometry: PolygonGeometry | MultiPolygonGeometry): Position[] {
  const rawPositions = geometry.type === "Polygon" ? geometry.coordinates.flat() : geometry.coordinates.flat(2);
  return rawPositions.filter(isPosition);
}

export function boundsForPositions(positions: Position[]): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of positions) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  return [minX, minY, maxX, maxY].every(Number.isFinite) ? [minX, minY, maxX, maxY] : null;
}

export function centroidForGeometry(geometry: Geometry): Position | null {
  if (geometry.type === "Point") return isPosition(geometry.coordinates) ? geometry.coordinates : null;
  const bounds = boundsForPositions(polygonPositions(geometry));
  if (!bounds) return null;
  const [minX, minY, maxX, maxY] = bounds;
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

