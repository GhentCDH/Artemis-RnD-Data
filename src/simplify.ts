/**
 * Polygon simplification strategies
 * Pluggable architecture for mask point reduction algorithms
 */

export type SimplificationAlgorithm = "none" | "douglas-peucker" | "greedy-batching";

export interface SimplifierConfig {
  algorithm: SimplificationAlgorithm;
  epsilon?: number;  // Douglas-Peucker epsilon (pixels)
  diagonalFactor?: number;  // Greedy-batching diagonal multiplier
  minDeviation?: number;  // Greedy-batching absolute minimum
}

// ---------------------------------------------------------------------------
// Douglas-Peucker Algorithm (Ramer-Douglas-Peucker)
// Recursive line simplification that preserves important features
// ---------------------------------------------------------------------------

function pointDistance(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function pointToSegmentDistance(
  point: [number, number],
  start: [number, number],
  end: [number, number]
): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lenSq = dx * dx + dy * dy;

  if (lenSq <= 1e-9) return pointDistance(point, start);

  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lenSq));
  const proj: [number, number] = [start[0] + t * dx, start[1] + t * dy];

  return pointDistance(point, proj);
}

function douglasPeucker(
  points: Array<[number, number]>,
  epsilon: number,
  start = 0,
  end = points.length - 1
): Array<[number, number]> {
  if (end - start < 2) return points.slice(start, end + 1);

  let maxDist = 0;
  let maxIndex = start;

  for (let i = start + 1; i < end; i++) {
    const dist = pointToSegmentDistance(points[i], points[start], points[end]);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points, epsilon, start, maxIndex);
    const right = douglasPeucker(points, epsilon, maxIndex, end);
    return [...left.slice(0, -1), ...right];
  }

  return [points[start], points[end]];
}

export function simplifyPolygonDouglasPeucker(
  points: Array<[number, number]>,
  epsilon: number
): Array<[number, number]> {
  if (points.length < 3) return points;

  // For closed polygons, remove duplicate closing point if present
  let workingPoints = points;
  if (
    workingPoints.length > 1 &&
    workingPoints[0][0] === workingPoints[workingPoints.length - 1][0] &&
    workingPoints[0][1] === workingPoints[workingPoints.length - 1][1]
  ) {
    workingPoints = workingPoints.slice(0, -1);
  }

  const simplified = douglasPeucker(workingPoints, epsilon, 0, workingPoints.length - 1);

  // Ensure we have at least 3 points for a valid polygon
  if (simplified.length < 3) return workingPoints;

  return simplified;
}

// ---------------------------------------------------------------------------
// Greedy Batching Algorithm (Original)
// Iteratively removes low-impact points in batches
// ---------------------------------------------------------------------------

function pointKey([x, y]: [number, number]): string {
  return `${x},${y}`;
}

function normalizePolygon(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length < 2) return points;

  const out: Array<[number, number]> = [];
  for (const p of points) {
    if (out.length === 0 || pointKey(out[out.length - 1]) !== pointKey(p)) out.push(p);
  }
  if (out.length > 2 && pointKey(out[0]) === pointKey(out[out.length - 1])) out.pop();
  return out;
}

function scoreMaskPoint(
  prev: [number, number],
  point: [number, number],
  next: [number, number]
): { deviation: number; span: number } {
  const deviation = pointToSegmentDistance(point, prev, next);
  const span = pointDistance(prev, point) + pointDistance(point, next);
  return { deviation, span };
}

function linesIntersect(
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number]
): boolean {
  const ccw = (A: [number, number], B: [number, number], C: [number, number]): boolean => {
    return (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0]);
  };
  return ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
}

function hasSelfIntersections(pointsInput: Array<[number, number]>): boolean {
  const points = normalizePolygon(pointsInput);
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (j === (i - 1 + n) % n) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      if (linesIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

export function simplifyPolygonGreedyBatching(
  pointsInput: Array<[number, number]>,
  diagonalFactor: number,
  minDeviation: number,
  width?: number,
  height?: number
): Array<[number, number]> {
  let points = normalizePolygon(pointsInput);

  const diagonal = Number.isFinite(width) && Number.isFinite(height)
    ? Math.hypot(Number(width), Number(height))
    : 0;
  const deviationThreshold = Math.max(minDeviation, diagonal * diagonalFactor);

  const startLength = points.length;
  let removedAny = true;
  let iteration = 0;

  while (removedAny && points.length > 3) {
    iteration++;
    removedAny = false;
    const candidates: Array<{ index: number; score: number }> = [];

    for (let i = 0; i < points.length; i++) {
      const prev = points[(i - 1 + points.length) % points.length];
      const point = points[i];
      const next = points[(i + 1) % points.length];
      const { deviation, span } = scoreMaskPoint(prev, point, next);

      if (span <= 1e-9) {
        candidates.push({ index: i, score: -1 });
        continue;
      }
      if (deviation > deviationThreshold) continue;

      const score = deviation / deviationThreshold;
      candidates.push({ index: i, score });
    }

    if (candidates.length < 1) break;
    candidates.sort((a, b) => a.score - b.score);

    let removedThisRound = 0;
    const maxRemovalPerRound = Math.max(1, Math.floor(candidates.length * 0.3));

    for (const candidate of candidates) {
      if (removedThisRound >= maxRemovalPerRound) break;
      const nextPoints = points.filter((_, index) => index !== candidate.index);
      if (nextPoints.length < 3 || hasSelfIntersections(nextPoints)) continue;
      points = nextPoints;
      removedThisRound++;
      removedAny = true;
    }
  }

  return points;
}

// ---------------------------------------------------------------------------
// Public API: Pluggable simplifier factory
// ---------------------------------------------------------------------------

export function createSimplifier(config: SimplifierConfig) {
  return (
    points: Array<[number, number]>,
    width?: number,
    height?: number
  ): Array<[number, number]> => {
    if (config.algorithm === "none") {
      return points;
    }

    if (config.algorithm === "douglas-peucker") {
      const epsilon = config.epsilon ?? 2.0;
      return simplifyPolygonDouglasPeucker(points, epsilon);
    }

    if (config.algorithm === "greedy-batching") {
      const diagonalFactor = config.diagonalFactor ?? 0.75;
      const minDeviation = config.minDeviation ?? 3;
      return simplifyPolygonGreedyBatching(points, diagonalFactor, minDeviation, width, height);
    }

    throw new Error(`Unknown simplification algorithm: ${config.algorithm}`);
  };
}

// Get configuration from environment or defaults
export function getSimplificationConfig(): SimplifierConfig {
  const algorithm = (process.env.MASK_SIMPLIFY_ALGORITHM as SimplificationAlgorithm) || "douglas-peucker";
  const epsilon = process.env.MASK_SIMPLIFY_EPSILON ? parseFloat(process.env.MASK_SIMPLIFY_EPSILON) : 2.0;
  const diagonalFactor = process.env.MASK_SIMPLIFY_DIAGONAL_FACTOR ? parseFloat(process.env.MASK_SIMPLIFY_DIAGONAL_FACTOR) : 0.75;
  const minDeviation = process.env.MASK_SIMPLIFY_MIN_DEVIATION ? parseFloat(process.env.MASK_SIMPLIFY_MIN_DEVIATION) : 3;

  return { algorithm, epsilon, diagonalFactor, minDeviation };
}
