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

export function truncate(
  input: string,
  limit: number,
  headRatio = 0.6,
): TruncateResult {
  const originalLength = input.length;
  if (limit <= 0 || originalLength <= limit) {
    return { text: input, truncated: false, originalLength, omitted: 0 };
  }

  const marker = (omitted: number): string =>
    `\n... [salida truncada: ${omitted} caracteres omitidos] ...\n`;

  // Reserve room for the marker so the result never exceeds `limit`.
  const markerReserve = 64;
  const budget = Math.max(0, limit - markerReserve);
  const headLen = Math.floor(budget * headRatio);
  const tailLen = budget - headLen;
  const head = input.slice(0, headLen);
  const tail = input.slice(input.length - tailLen);
  const omitted = originalLength - head.length - tail.length;

  return {
    text: `${head}${marker(omitted)}${tail}`,
    truncated: true,
    originalLength,
    omitted,
  };
}
