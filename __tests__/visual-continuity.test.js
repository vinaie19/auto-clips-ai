import { describe, expect, it } from "vitest";
import { normalizeVisualPlan, MIN_SHOTS, MAX_SHOTS } from "@/lib/visual-queries";
import {
  computeSegmentDurations,
  splitScriptSentences,
} from "@/lib/segment-durations";

describe("normalizeVisualPlan", () => {
  it("keeps motif and caps shots at MAX_SHOTS", () => {
    const plan = normalizeVisualPlan(
      {
        motif: "morning coffee ritual",
        shots: [
          { query: "coffee pour close up", weight: 1.5 },
          { query: "steam rising mug", weight: 1 },
          { query: "hands holding ceramic cup", weight: 1.2 },
          { query: "coffee beans detail", weight: 0.8 },
          { query: "cafe window light", weight: 1 },
          { query: "espresso machine", weight: 1 },
        ],
        avoid: ["gym", "random portraits"],
      },
      "coffee tips"
    );

    expect(plan.motif).toBe("morning coffee ritual");
    expect(plan.queries).toHaveLength(MAX_SHOTS);
    expect(plan.weights).toHaveLength(MAX_SHOTS);
    expect(plan.avoid).toContain("gym");
    expect(plan.queries[0]).toBe("coffee pour close up");
    expect(plan.weights[0]).toBe(1.5);
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

  it("accepts legacy queries array", () => {
    const plan = normalizeVisualPlan(
      { queries: ["a", "b", "c", "a"] },
      "topic"
    );
    expect(plan.queries).toEqual(["a", "b", "c"]);
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
});
