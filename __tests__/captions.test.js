import { describe, expect, it } from "vitest";
import {
  chunkIntoPunchyBlocks,
  computeCaptionTimings,
} from "../worker/pipeline/captions.js";

describe("chunkIntoPunchyBlocks", () => {
  it("splits into short caption blocks", () => {
    const blocks = chunkIntoPunchyBlocks("one two three four five six seven", 3);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join(" ")).toContain("one");
  });
});

describe("computeCaptionTimings", () => {
  it("keeps caption windows inside the VO duration", () => {
    const blocks = chunkIntoPunchyBlocks(
      "one two three four five six seven eight nine ten eleven twelve",
      3
    );
    const timings = computeCaptionTimings(blocks, 40);
    expect(timings.length).toBe(blocks.length);
    expect(timings[0].start).toBe(0);
    expect(timings[timings.length - 1].end).toBeCloseTo(40, 3);
    for (const t of timings) {
      expect(t.end).toBeGreaterThan(t.start);
      expect(t.end).toBeLessThanOrEqual(40.001);
    }
  });

  it("does not overrun when many short blocks would have needed a min floor", () => {
    const blocks = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const timings = computeCaptionTimings(blocks, 30);
    expect(timings[timings.length - 1].end).toBeCloseTo(30, 3);
    const span = timings.reduce((sum, t) => sum + (t.end - t.start), 0);
    expect(span).toBeCloseTo(30, 2);
  });
});
