import { describe, expect, it } from "vitest";
import {
  resolveCaptionsEnabled,
  resolveTtsVoice,
  TTS_VOICE_IDS,
} from "@/lib/render-constants";

describe("resolveTtsVoice", () => {
  it("accepts known voice ids", () => {
    expect(resolveTtsVoice("onyx")).toBe("onyx");
    expect(resolveTtsVoice("Nova")).toBe("nova");
  });

  it("falls back to tone default", () => {
    expect(resolveTtsVoice(undefined, "Moody")).toBe("onyx");
    expect(resolveTtsVoice("nope", "Corporate")).toBe("alloy");
  });

  it("catalog covers previewable voices", () => {
    expect(TTS_VOICE_IDS).toContain("shimmer");
    expect(TTS_VOICE_IDS.length).toBeGreaterThanOrEqual(6);
  });
});

describe("resolveCaptionsEnabled", () => {
  it("defaults to true", () => {
    expect(resolveCaptionsEnabled(undefined)).toBe(true);
    expect(resolveCaptionsEnabled(true)).toBe(true);
  });

  it("treats falsey flags as off", () => {
    expect(resolveCaptionsEnabled(false)).toBe(false);
    expect(resolveCaptionsEnabled("false")).toBe(false);
  });
});
