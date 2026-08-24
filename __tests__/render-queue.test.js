import { describe, expect, it } from "vitest";
import { computeBackoffSeconds, isRetryableError } from "@/lib/render-constants";

describe("render-constants", () => {
  it("computeBackoffSeconds matches plan formula", () => {
    expect(computeBackoffSeconds(0)).toBe(30);
    expect(computeBackoffSeconds(1)).toBe(45);
    expect(computeBackoffSeconds(2)).toBe(68);
    expect(computeBackoffSeconds(99)).toBe(180);
  });

  it("isRetryableError distinguishes transient vs permanent", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableError(new Error("empty script"))).toBe(false);
    expect(isRetryableError(new Error("ffmpeg is not installed"))).toBe(false);
  });
});
