import { describe, expect, it } from "vitest";
import {
  normalizeVisualPlan,
  beatLinesFromScript,
  isVagueStockQuery,
  hardenStockQuery,
  MIN_SHOTS,
  MAX_SHOTS,
} from "@/lib/visual-queries";
import {
  computeSegmentDurations,
  splitScriptSentences,
} from "@/lib/segment-durations";
import { countUniqueBeatUrls, mapPool } from "@/lib/pexels-broll";

describe("isVagueStockQuery / hardenStockQuery", () => {
  it("flags vague intensity / filler queries", () => {
    expect(isVagueStockQuery("intense workout close up")).toBe(true);
    expect(isVagueStockQuery("home workout intensity")).toBe(true);
    expect(isVagueStockQuery("person working out")).toBe(true);
    expect(isVagueStockQuery("coffee pour close up")).toBe(false);
    expect(isVagueStockQuery("person doing push-ups on floor")).toBe(false);
  });

  it("rewrites vague queries from the spoken line", () => {
    const q = hardenStockQuery(
      "intense workout close up",
      "Do twenty push-ups on the living room floor.",
      "10-minute home workout with no equipment"
    );
    expect(isVagueStockQuery(q)).toBe(false);
    expect(q.toLowerCase()).toMatch(/push/);
  });
});

describe("beatLinesFromScript", () => {
  it("clamps spoken lines to MIN–MAX beats", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}.`).join(" ");
    const lines = beatLinesFromScript(many);
    expect(lines.length).toBeGreaterThanOrEqual(MIN_SHOTS);
    expect(lines.length).toBeLessThanOrEqual(MAX_SHOTS);
    expect(lines[lines.length - 1]).toContain("Line");
  });

  it("splits compound actions on and for more beats", () => {
    const lines = beatLinesFromScript(
      "Whisk the eggs until they are blended and heat the pan."
    );
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => /blended/i.test(l))).toBe(true);
    expect(lines.some((l) => /heat/i.test(l))).toBe(true);
  });
});

describe("normalizeVisualPlan", () => {
  it("binds each shot to a script line with word-count weights", () => {
    const lines = [
      "Pour the coffee slowly.",
      "Steam rises from the mug.",
      "Hands wrap around ceramic.",
    ];
    const plan = normalizeVisualPlan(
      {
        motif: "morning coffee ritual",
        shots: [
          { lineIndex: 1, query: "coffee pour close up" },
          { lineIndex: 2, query: "steam rising mug" },
          { lineIndex: 3, query: "hands holding ceramic cup" },
        ],
        avoid: ["gym"],
      },
      "coffee tips",
      { lines }
    );

    expect(plan.motif).toBe("morning coffee ritual");
    expect(plan.beats).toHaveLength(3);
    expect(plan.lines).toEqual(lines);
    expect(plan.queries[0]).toBe("coffee pour close up");
    expect(plan.beats[0].line).toBe(lines[0]);
    expect(plan.weights[0]).toBe(4);
    expect(plan.weights[1]).toBe(5);
    expect(plan.avoid).toContain("gym");
  });

  it("keeps motif and caps shots at MAX_SHOTS", () => {
    const shots = Array.from({ length: MAX_SHOTS + 5 }, (_, i) => ({
      query: `coffee shot ${i + 1}`,
      weight: 1,
    }));
    const plan = normalizeVisualPlan(
      {
        motif: "morning coffee ritual",
        shots,
        avoid: ["gym", "random portraits"],
      },
      "coffee tips"
    );

    expect(plan.motif).toBe("morning coffee ritual");
    expect(plan.queries).toHaveLength(MAX_SHOTS);
    expect(plan.weights).toHaveLength(MAX_SHOTS);
    expect(plan.avoid).toContain("gym");
    expect(plan.queries[0]).toBe("coffee shot 1");
  });

  it("fills to MIN_SHOTS from motif when sparse", () => {
    const plan = normalizeVisualPlan(
      {
        motif: "laptop desk setup",
        shots: [{ query: "typing on laptop", weight: 1 }],
      },
      "productivity"
    );

    expect(plan.queries.length).toBeGreaterThanOrEqual(MIN_SHOTS);
    expect(plan.queries.length).toBeLessThanOrEqual(MAX_SHOTS);
  });

  it("accepts legacy queries array and pads to MIN_SHOTS", () => {
    const plan = normalizeVisualPlan(
      { queries: ["a", "b", "c", "a"] },
      "topic"
    );
    expect(plan.queries.slice(0, 3)).toEqual(["a", "b", "c"]);
    expect(plan.queries.length).toBeGreaterThanOrEqual(MIN_SHOTS);
  });
});

describe("computeSegmentDurations", () => {
  it("uses explicit weights", () => {
    const segs = computeSegmentDurations(30, 3, { weights: [1, 2, 1] });
    expect(segs).toHaveLength(3);
    const sum = segs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(30, 1);
    expect(segs[1]).toBeGreaterThan(segs[0]);
  });

  it("weights by script sentences when no weights", () => {
    const script =
      "Short. This second sentence has many more spoken words than the first one does.";
    const sentences = splitScriptSentences(script);
    expect(sentences.length).toBe(2);

    const segs = computeSegmentDurations(20, 2, { script });
    expect(segs[1]).toBeGreaterThan(segs[0]);
  });

  it("falls back to equal shares", () => {
    const segs = computeSegmentDurations(15, 3);
    expect(segs.every((s) => Math.abs(s - 5) < 0.05)).toBe(true);
  });

  it("line word weights stretch longer spoken beats on screen", () => {
    const segs = computeSegmentDurations(40, 3, { weights: [4, 12, 4] });
    expect(segs[1]).toBeGreaterThan(segs[0]);
    expect(segs[1]).toBeGreaterThan(segs[2]);
  });
});

describe("countUniqueBeatUrls", () => {
  it("counts distinct clip URLs (no last-clip padding)", () => {
    expect(
      countUniqueBeatUrls([
        { url: "https://a.mp4" },
        { url: "https://b.mp4" },
        { url: "https://a.mp4" },
      ])
    ).toBe(2);
    expect(countUniqueBeatUrls([])).toBe(0);
  });
});

describe("mapPool", () => {
  it("runs with bounded concurrency and preserves order", async () => {
    const started = [];
    const result = await mapPool([10, 20, 30, 40], 2, async (n, i) => {
      started.push(i);
      await new Promise((r) => setTimeout(r, 5));
      return n * 2;
    });
    expect(result).toEqual([20, 40, 60, 80]);
    expect(started).toHaveLength(4);
  });
});
