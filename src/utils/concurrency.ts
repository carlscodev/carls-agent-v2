/**
 * Runs `fn` over every item with at most `limit` in flight, preserving the input
 * order in the result. Order matters at every call site: tool_result blocks must
 * line up with the tool_use blocks that produced them, and a pool's reports are
 * easier to read in the order they were requested.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await fn(item);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
