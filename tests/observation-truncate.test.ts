import { describe, expect, it } from "vitest";

import { truncate } from "../src/utils/truncate.js";

/**
 * `truncate` is the last thing between a runaway command's output and the
 * context window, and it documents a hard guarantee: "the result never exceeds
 * `limit`". The marker it inserts grows with the digits of the omitted count, so
 * the head+tail budget and the marker width are coupled. A fixed reserve ignored
 * that and let a small limit overflow — the exact case a caller reaches for when
 * it wants a short observation.
 */
describe("observation truncate", () => {
  it("never exceeds the limit when the omitted count is wide", () => {
    const input = "a".repeat(5000);
    for (const limit of [1, 10, 20, 40, 52, 53, 63, 64, 65, 100]) {
      const result = truncate(input, limit);
      expect(result.text.length, `limit ${limit}`).toBeLessThanOrEqual(limit);
    }
  });

  it("stays within the limit across a wide sweep of sizes and limits", () => {
    for (let size = 0; size <= 2000; size += 13) {
      const input = "x".repeat(size);
      for (let limit = 1; limit <= Math.min(size + 2, 300); limit++) {
        const result = truncate(input, limit);
        expect(result.text.length).toBeLessThanOrEqual(limit);
        if (size <= limit) {
          expect(result.truncated).toBe(false);
          expect(result.text).toBe(input);
        } else {
          expect(result.truncated).toBe(true);
          expect(result.omitted).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps the head and the tail and names the omission", () => {
    const input = `${"H".repeat(400)}${"T".repeat(400)}`;
    const result = truncate(input, 200);

    expect(result.text.length).toBeLessThanOrEqual(200);
    expect(result.text.startsWith("H")).toBe(true);
    expect(result.text.endsWith("T")).toBe(true);
    expect(result.text).toContain("salida truncada");
  });

  it("counts the omission consistently with the rendered head and tail", () => {
    const input = "abcdefghij".repeat(500);
    const result = truncate(input, 500);
    const marker = result.text.match(/\[salida truncada: (\d+) caracteres omitidos\]/);
    expect(marker).not.toBeNull();
    const claimed = Number(marker?.[1]);
    const kept = result.text.replace(/\n\.\.\. \[salida truncada: \d+ caracteres omitidos\] \.\.\.\n/, "");
    expect(claimed).toBe(input.length - kept.length);
    expect(claimed).toBe(result.omitted);
  });

  it("passes short input through untouched and honours a non-positive limit", () => {
    expect(truncate("short", 1000)).toMatchObject({ text: "short", truncated: false, omitted: 0 });
    expect(truncate("anything", 0)).toMatchObject({ text: "anything", truncated: false });
  });
});
