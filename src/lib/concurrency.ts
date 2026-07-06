/**
 * Run `worker` over `items` with at most `concurrency` in flight.
 * Used to parse/transform many source geojson files in parallel.
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let cursor = 0;

  async function pump(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => pump()));
}
