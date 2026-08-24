import { describe, expect, it } from "vitest";
import {
  resolveAspectRatio,
  resolveTargetDuration,
  ASPECT_RATIO_IDS,
  VIDEO_DURATION_SECONDS,
} from "@/lib/render-constants";
import { buildAtempoFilter } from "../worker/pipeline/ffmpeg.js";

describe("resolveTargetDuration", () => {
  it("accepts 30/45/60 and defaults to 45", () => {
    expect(resolveTargetDuration(30)).toBe(30);
    expect(resolveTargetDuration("60")).toBe(60);
    expect(resolveTargetDuration(99)).toBe(45);
    expect(VIDEO_DURATION_SECONDS).toEqual([30, 45, 60]);
  });
});

describe("resolveAspectRatio", () => {
  it("accepts known ratios", () => {
    expect(resolveAspectRatio("16:9")).toBe("16:9");
    expect(resolveAspectRatio("1:1")).toBe("1:1");
    expect(resolveAspectRatio("nope")).toBe("9:16");
    expect(ASPECT_RATIO_IDS).toContain("9:16");
  });
});

describe("buildAtempoFilter", () => {
  it("chains when speed exceeds 2x", () => {
    expect(buildAtempoFilter(3)).toContain("atempo=2.0");
  });
});
