/**
 * Test script to compare mask simplification algorithms
 * Run with: bun test-simplify.ts
 * Or test specific algorithms: bun test-simplify.ts douglas-peucker
 */

import { createSimplifier } from "./src/simplify";

// Example mask: a rectangle with many points along the edges
function generateTestMask(): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const width = 512;
  const height = 512;

  // Top edge (many intermediate points)
  for (let x = 0; x <= width; x += 5) {
    points.push([x, 0]);
  }

  // Right edge
  for (let y = 5; y <= height; y += 5) {
    points.push([width, y]);
  }

  // Bottom edge (reversed)
  for (let x = width - 5; x >= 0; x -= 5) {
    points.push([x, height]);
  }

  // Left edge (reversed)
  for (let y = height - 5; y > 0; y -= 5) {
    points.push([0, y]);
  }

  return points;
}

// Example mask: circle with many points
function generateCircleMask(radius = 200, centerX = 256, centerY = 256): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const steps = 360; // One point per degree

  for (let angle = 0; angle < 360; angle += 360 / steps) {
    const rad = (angle * Math.PI) / 180;
    const x = centerX + radius * Math.cos(rad);
    const y = centerY + radius * Math.sin(rad);
    points.push([Math.round(x), Math.round(y)]);
  }

  return points;
}

function testAlgorithm(
  name: string,
  points: Array<[number, number]>,
  config: { algorithm: "douglas-peucker" | "greedy-batching"; epsilon?: number; diagonalFactor?: number; minDeviation?: number }
) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Testing: ${name}`);
  console.log(`Config: ${JSON.stringify(config)}`);
  console.log(`Input: ${points.length} points`);

  const simplify = createSimplifier(config);
  const start = performance.now();
  const simplified = simplify(points, 512, 512);
  const elapsed = (performance.now() - start).toFixed(2);

  const removed = points.length - simplified.length;
  const percentRemoved = ((removed / points.length) * 100).toFixed(1);

  console.log(`Output: ${simplified.length} points`);
  console.log(`Removed: ${removed} points (${percentRemoved}%)`);
  console.log(`Time: ${elapsed}ms`);
}

async function main() {
  const algorithm = process.argv[2] || "all";

  console.log("📐 Polygon Simplification Algorithm Comparison");
  console.log("━".repeat(70));

  const rectMask = generateTestMask();
  const circleMask = generateCircleMask();

  if (algorithm === "all" || algorithm === "douglas-peucker") {
    console.log("\n🔷 DOUGLAS-PEUCKER ALGORITHM");
    testAlgorithm("Rectangle with epsilon=1.0", rectMask, {
      algorithm: "douglas-peucker",
      epsilon: 1.0
    });
    testAlgorithm("Rectangle with epsilon=2.0", rectMask, {
      algorithm: "douglas-peucker",
      epsilon: 2.0
    });
    testAlgorithm("Rectangle with epsilon=5.0", rectMask, {
      algorithm: "douglas-peucker",
      epsilon: 5.0
    });
    testAlgorithm("Circle with epsilon=2.0", circleMask, {
      algorithm: "douglas-peucker",
      epsilon: 2.0
    });
  }

  if (algorithm === "all" || algorithm === "greedy-batching") {
    console.log("\n🔶 GREEDY BATCHING ALGORITHM (Original)");
    testAlgorithm("Rectangle with diagonalFactor=0.75", rectMask, {
      algorithm: "greedy-batching",
      diagonalFactor: 0.75,
      minDeviation: 3
    });
    testAlgorithm("Rectangle with diagonalFactor=0.1", rectMask, {
      algorithm: "greedy-batching",
      diagonalFactor: 0.1,
      minDeviation: 3
    });
    testAlgorithm("Circle with diagonalFactor=0.75", circleMask, {
      algorithm: "greedy-batching",
      diagonalFactor: 0.75,
      minDeviation: 3
    });
  }

  console.log("\n" + "=".repeat(70));
  console.log("✅ Test complete");
  console.log("\n📝 Usage:");
  console.log("  bun test-simplify.ts                    # Test all algorithms");
  console.log("  bun test-simplify.ts douglas-peucker    # Test Douglas-Peucker only");
  console.log("  bun test-simplify.ts greedy-batching    # Test Greedy Batching only");
}

main().catch(console.error);
