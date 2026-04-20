# Mask Simplification Configuration

The data pipeline supports **pluggable polygon simplification algorithms** for reducing the number of points in resource masks while preserving important geometric features.

## Quick Start

By default, the pipeline uses **Douglas-Peucker** with `epsilon=2.0`:

```bash
# Run with default (Douglas-Peucker, epsilon=2.0)
npm run build
```

## Available Algorithms

### 1. Douglas-Peucker (Recommended)

**The new default.** A recursive line simplification algorithm that intelligently preserves important features (corners, curves) while removing redundant points.

**Pros:**
- ✅ Preserves shape and corners naturally
- ✅ Single, intuitive parameter (`epsilon`)
- ✅ Excellent for both angular and curved masks
- ✅ Fast performance

**Cons:**
- Needs epsilon tuning per use case

**Configuration:**
```bash
# Default (epsilon=2.0)
npm run build

# Aggressive simplification (remove more points)
MASK_SIMPLIFY_ALGORITHM=douglas-peucker MASK_SIMPLIFY_EPSILON=0.5 npm run build

# Gentle simplification (preserve more detail)
MASK_SIMPLIFY_ALGORITHM=douglas-peucker MASK_SIMPLIFY_EPSILON=5.0 npm run build
```

**Epsilon Guidelines:**
- `0.5px` — Very aggressive, keeps only major shape
- `1.0px` — Aggressive, good for coarse masks
- `2.0px` — Balanced (default, good for most cases)
- `5.0px` — Gentle, preserves most detail
- `10.0px` — Very gentle, minimal simplification

### 2. Greedy Batching (Legacy)

**The original algorithm.** Iteratively removes low-impact points in batches, checking for self-intersections.

**Pros:**
- Battle-tested in production
- Predictable iterative behavior

**Cons:**
- ❌ **Brutally aggressive** with standard settings
- ❌ Hard to tune (multiplies image diagonal)
- ❌ Loses fine detail and curves
- ❌ Slower (100-300ms vs 0-3ms for RDP)

**Configuration:**
```bash
# Original aggressive settings (NOT RECOMMENDED)
MASK_SIMPLIFY_ALGORITHM=greedy-batching \
  MASK_SIMPLIFY_DIAGONAL_FACTOR=0.75 \
  MASK_SIMPLIFY_MIN_DEVIATION=3 \
  npm run build

# More conservative version
MASK_SIMPLIFY_ALGORITHM=greedy-batching \
  MASK_SIMPLIFY_DIAGONAL_FACTOR=0.1 \
  MASK_SIMPLIFY_MIN_DEVIATION=3 \
  npm run build
```

**Parameters:**
- `MASK_SIMPLIFY_DIAGONAL_FACTOR` — Multiplier on image diagonal (0.0–1.0)
  - How it works: `threshold = max(minDeviation, diagonal × factor)`
  - For 512×512 image: diagonal ≈ 724px, so 0.75 × 724 = 543px threshold
  - **Problem:** Only keeps points that deviate >543px, which is huge!
- `MASK_SIMPLIFY_MIN_DEVIATION` — Absolute minimum deviation in pixels

## Testing Algorithms

A test script lets you compare both algorithms on synthetic masks:

```bash
# Test all algorithms
bun test-simplify.ts

# Test specific algorithm
bun test-simplify.ts douglas-peucker
bun test-simplify.ts greedy-batching
```

Example output:
```
🔷 DOUGLAS-PEUCKER (epsilon=2.0)
Testing: Circle with epsilon=2.0
Input: 360 points
Output: 33 points
Removed: 327 points (90.8%)
Time: 1.02ms

🔶 GREEDY BATCHING (diagonalFactor=0.75)
Testing: Circle with diagonalFactor=0.75
Input: 360 points
Output: 3 points
Removed: 357 points (99.2%)
Time: 194.67ms
```

Notice how greedy batching removes 99.2% of circle points (keeping only ~3), while Douglas-Peucker intelligently keeps 33 points to preserve the curve shape.

## Implementation Details

### Module: `src/simplify.ts`

Pluggable architecture for adding new algorithms:

```typescript
// Create a simplifier with desired configuration
const simplify = createSimplifier({
  algorithm: "douglas-peucker",
  epsilon: 2.0
});

// Apply to mask points
const simplified = simplify(maskPoints, imageWidth, imageHeight);
```

### Adding New Algorithms

1. Implement simplification function:
   ```typescript
   export function simplifyPolygonMyNewAlgorithm(
     points: Array<[number, number]>,
     customParam: number
   ): Array<[number, number]> {
     // ... implementation
   }
   ```

2. Add type to `SimplificationAlgorithm`:
   ```typescript
   export type SimplificationAlgorithm = "douglas-peucker" | "greedy-batching" | "my-new-algorithm";
   ```

3. Add config option to `SimplifierConfig`:
   ```typescript
   export interface SimplifierConfig {
     algorithm: SimplificationAlgorithm;
     myNewParam?: number;
   }
   ```

4. Update `createSimplifier()` factory:
   ```typescript
   if (config.algorithm === "my-new-algorithm") {
     return (points, width, height) => simplifyPolygonMyNewAlgorithm(points, config.myNewParam ?? 1.0);
   }
   ```

## Troubleshooting

**Masks losing too much detail?**
- Reduce `epsilon` (Douglas-Peucker) or `diagonalFactor` (Greedy)
- Example: `MASK_SIMPLIFY_EPSILON=1.0`

**Simplification too slow?**
- Switch to Douglas-Peucker (faster by ~100x)
- Increase epsilon to simplify more aggressively

**Polygons becoming self-intersecting?**
- Current implementation checks for self-intersections and uses convex hull as fallback
- If problems persist, reduce the simplification threshold

**Want to disable simplification?**
- Use very high epsilon or diagonal factor
- Or modify `simplify.ts` to add a "none" algorithm option

## Performance Notes

**Douglas-Peucker:**
- ~0.2–3ms for typical masks (360–409 points)
- Linear in output size, not input size
- No iterations needed

**Greedy Batching:**
- ~200–300ms for typical masks
- Iterative, checks self-intersections each round
- Slower but predictable

## References

- **Douglas-Peucker Algorithm:** [Wikipedia](https://en.wikipedia.org/wiki/Ramer%E2%80%93Douglas%E2%80%93Peucker_algorithm)
- **Visvalingam-Whyatt Algorithm:** Alternative line simplification (not yet implemented)
