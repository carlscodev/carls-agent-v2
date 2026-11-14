/**
 * Observation truncation. Verbose command output would otherwise flood the
 * context window, so long observations are kept head+tail with an explicit
 * marker of how many characters were dropped.
 */
export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalLength: number;
  omitted: number;
}

/** The head+tail marker, naming how many characters were dropped. */
function omittedMarker(omitted: number): string {
  return `\n... [salida truncada: ${omitted} caracteres omitidos] ...\n`;
}

/** A head and a tail holding exactly `budget` characters between them. */
function splitAt(input: string, budget: number, headRatio: number): { head: string; tail: string } {
  const headLen = Math.floor(budget * headRatio);
  const tailLen = budget - headLen;
  return {
    head: input.slice(0, headLen),
    tail: tailLen > 0 ? input.slice(input.length - tailLen) : "",
  };
}

export function truncate(
  input: string,
  limit: number,
  headRatio = 0.6,
): TruncateResult {
  const originalLength = input.length;
  if (limit <= 0 || originalLength <= limit) {
    return { text: input, truncated: false, originalLength, omitted: 0 };
  }

  // The marker's width grows with the digits of `omitted`, while `omitted` shrinks
  // as the marker takes more room. A fixed reserve ignored that coupling: past
  // three digits the marker outgrew it, so the "never exceeds `limit`" promise
  // broke on a small limit. Reserve the widest marker the input could ever need —
  // `omitted` is at most `originalLength` — so the result is bounded by `limit` by
  // construction.
  const reserve = omittedMarker(originalLength).length;
  if (limit >= reserve) {
    const { head, tail } = splitAt(input, limit - reserve, headRatio);
    const omitted = originalLength - head.length - tail.length;
    return {
      text: `${head}${omittedMarker(omitted)}${tail}`,
      truncated: true,
      originalLength,
      omitted,
    };
  }

  // `limit` is too small for the descriptive marker. Fall back to a compact
  // `...N...`; if not even that fits, keep a bare head slice. The result stays
  // within `limit` in every branch.
  const compact = `...${originalLength}...`;
  if (limit >= compact.length) {
    const { head, tail } = splitAt(input, limit - compact.length, headRatio);
    const omitted = originalLength - head.length - tail.length;
    return { text: `${head}...${omitted}...${tail}`, truncated: true, originalLength, omitted };
  }
  return {
    text: input.slice(0, limit),
    truncated: true,
    originalLength,
    omitted: originalLength - limit,
  };
}
