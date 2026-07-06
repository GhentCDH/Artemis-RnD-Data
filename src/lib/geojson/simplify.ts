import type { Position } from "./types";

export type SimplifiedRing<T extends Position = Position> = {
  points: T[];
  indices: number[];
};

function pointDistance(a: Position, b: Position): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function pointToSegmentDistance(point: Position, start: Position, end: Position): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) return pointDistance(point, start);

  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lenSq));
  return pointDistance(point, [start[0] + t * dx, start[1] + t * dy]);
}

function douglasPeuckerIndices(points: Position[], epsilon: number, start = 0, end = points.length - 1): number[] {
  if (end - start < 2) return [start, end];

  let maxDist = 0;
  let maxIndex = start;
  for (let i = start + 1; i < end; i++) {
    const dist = pointToSegmentDistance(points[i]!, points[start]!, points[end]!);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist <= epsilon) return [start, end];

  const left = douglasPeuckerIndices(points, epsilon, start, maxIndex);
  const right = douglasPeuckerIndices(points, epsilon, maxIndex, end);
  return [...left.slice(0, -1), ...right];
}

function stripClosingPoint<T extends Position>(points: T[]): { points: T[]; closed: boolean } {
  const isClosed =
    points.length > 1 &&
    points[0]![0] === points[points.length - 1]![0] &&
    points[0]![1] === points[points.length - 1]![1];
  return { points: isClosed ? points.slice(0, -1) : points, closed: isClosed };
}

export function simplifyRingDetailed<T extends Position>(points: T[], epsilon: number): SimplifiedRing<T> {
  if (points.length < 4 || epsilon <= 0) {
    return { points, indices: points.map((_, index) => index) };
  }

  const { points: working, closed } = stripClosingPoint(points);
  const indices = [...new Set(douglasPeuckerIndices(working, epsilon))].sort((a, b) => a - b);
  if (indices.length < 3) return { points, indices: points.map((_, index) => index) };

  const simplified = indices.map((index) => working[index]!);
  return {
    points: closed ? [...simplified, simplified[0]!] : simplified,
    indices: closed ? [...indices, 0] : indices,
  };
}

export function simplifyRing<T extends Position>(points: T[], epsilon: number): T[] {
  return simplifyRingDetailed(points, epsilon).points;
}

export function simplifyRingByReference<T extends Position>(
  targetPoints: T[],
  referencePoints: Position[],
  epsilon: number,
): T[] {
  if (targetPoints.length !== referencePoints.length) return simplifyRing(targetPoints, epsilon);

  const simplifiedReference = simplifyRingDetailed(referencePoints, epsilon);
  return simplifiedReference.indices.map((index) => targetPoints[index]!);
}
