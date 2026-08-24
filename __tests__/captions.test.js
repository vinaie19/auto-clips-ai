import { describe, expect, it } from "vitest";
import {
  chunkIntoPunchyBlocks,
  computeCaptionTimings,
} from "../worker/pipeline/captions.js";
import {
  timingsFromWordAlignment,
  normalizeWord,
  scaleWordTimings,
} from "../worker/pipeline/align-captions.js";

describe("chunkIntoPunchyBlocks", () => {
  it("splits into short caption blocks", () => {
    const blocks = chunkIntoPunchyBlocks("one two three four five six seven", 3);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join(" ")).toContain("one");
  });

  it("does not glue the end of one action onto the next after and", () => {
    const blocks = chunkIntoPunchyBlocks(
      "Whisk the eggs until they are blended and heat the pan.",
      3
    );
    const joined = blocks.map((b) => b.toLowerCase());
    expect(joined.some((b) => b.includes("blended") && b.includes("heat"))).toBe(
      false
    );
    expect(joined.some((b) => b.includes("blended"))).toBe(true);
    expect(joined.some((b) => b.includes("heat"))).toBe(true);
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

describe("normalizeWord", () => {
  it("folds curly apostrophes to ascii", () => {
    expect(normalizeWord("it’s")).toBe("it's");
    expect(normalizeWord("it's")).toBe("it's");
  });
});

describe("scaleWordTimings", () => {
  it("scales raw whisper times into fitted duration", () => {
    const scaled = scaleWordTimings(
      [
        { word: "hello", start: 0, end: 1 },
        { word: "world", start: 1, end: 2 },
      ],
      0.5
    );
    expect(scaled[0].end).toBeCloseTo(0.5, 3);
    expect(scaled[1].end).toBeCloseTo(1, 3);
  });
});

describe("timingsFromWordAlignment", () => {
  it("uses whisper word starts so captions do not begin before speech", () => {
    const blocks = ["hello world", "this works"];
    const words = [
      { word: "hello", start: 0.35, end: 0.7 },
      { word: "world", start: 0.75, end: 1.1 },
      { word: "this", start: 1.2, end: 1.4 },
      { word: "works", start: 1.45, end: 1.9 },
    ];
    const timings = timingsFromWordAlignment(blocks, words, 2.0);
    expect(timings[0].start).toBeGreaterThanOrEqual(0.35);
    expect(timings[0].text).toBe("hello world");
    expect(timings[1].start).toBeGreaterThanOrEqual(timings[0].end);
    expect(timings[timings.length - 1].end).toBeCloseTo(2.0, 3);
  });

  it("falls back to proportional timing when words are missing", () => {
    const blocks = ["one two", "three four"];
    const timings = timingsFromWordAlignment(blocks, [], 10);
    expect(timings[0].start).toBe(0);
    expect(timings[timings.length - 1].end).toBeCloseTo(10, 3);
  });

  it("matches curly script apostrophe to ascii whisper words", () => {
    const blocks = ["it’s a desk"];
    const words = [
      { word: "it's", start: 0.1, end: 0.3 },
      { word: "a", start: 0.35, end: 0.4 },
      { word: "desk", start: 0.45, end: 0.8 },
    ];
    const timings = timingsFromWordAlignment(blocks, words, 1.0);
    expect(timings).toHaveLength(1);
    expect(timings[0].start).toBeGreaterThanOrEqual(0.1);
    expect(timings[0].end).toBeCloseTo(1.0, 3);
  });

  it("skips whisper fillers mid-phrase without dumping later blocks", () => {
    const blocks = ["open notebooks", "soft breeze"];
    const words = [
      { word: "open", start: 0.0, end: 0.2 },
      { word: "uh", start: 0.22, end: 0.3 },
      { word: "notebooks", start: 0.35, end: 0.7 },
      { word: "soft", start: 0.8, end: 1.0 },
      { word: "breeze", start: 1.05, end: 1.4 },
    ];
    const timings = timingsFromWordAlignment(blocks, words, 1.5);
    expect(timings).toHaveLength(2);
    expect(timings[0].start).toBeCloseTo(0, 2);
    expect(timings[1].start).toBeGreaterThanOrEqual(timings[0].end);
    expect(timings[1].start).toBeGreaterThanOrEqual(0.8);
    expect(timings[1].end).toBeCloseTo(1.5, 3);
  });

  it("keeps later whisper sync after one weak mid block", () => {
    const blocks = ["hello world", "mystery phrase", "final words"];
    const words = [
      { word: "hello", start: 0.0, end: 0.2 },
      { word: "world", start: 0.25, end: 0.5 },
      { word: "final", start: 1.2, end: 1.4 },
      { word: "words", start: 1.45, end: 1.8 },
    ];
    const timings = timingsFromWordAlignment(blocks, words, 2.0);
    expect(timings).toHaveLength(3);
    expect(timings[0].text).toBe("hello world");
    expect(timings[2].text).toBe("final words");
    expect(timings[2].start).toBeGreaterThanOrEqual(1.2);
    expect(timings[2].end).toBeCloseTo(2.0, 3);
  });
});
