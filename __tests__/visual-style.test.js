import { describe, expect, it } from "vitest";
import {
  VISUAL_STYLES,
  VISUAL_STYLE_IDS,
  PURPOSE_BY_TONE,
  resolveVisualStyle,
  resolvePurpose,
} from "@/lib/render-constants";

describe("visual style ids", () => {
  it("pins exactly the 10 canonical lowercase-with-spaces ids", () => {
    expect(VISUAL_STYLE_IDS).toEqual([
      "realistic",
      "cinematic",
      "cartoon",
      "2d animation",
      "3d animation",
      "motion graphics",
      "anime/comic",
      "horror/dark",
      "minimal",
      "vintage",
    ]);
    expect(VISUAL_STYLES).toHaveLength(10);
    expect(VISUAL_STYLES.every((s) => s.id && s.label && s.blurb)).toBe(true);
  });

  it("resolveVisualStyle normalizes casing, omits Auto, rejects unknown", () => {
    expect(resolveVisualStyle("cartoon")).toBe("cartoon");
    expect(resolveVisualStyle("2D ANIMATION")).toBe("2d animation");
    expect(resolveVisualStyle("auto")).toBeNull();
    expect(resolveVisualStyle("")).toBeNull();
    expect(resolveVisualStyle(undefined)).toBeNull();
    expect(resolveVisualStyle("not-a-style")).toBeUndefined();
  });

  it("resolvePurpose maps every tone and falls back to storytelling", () => {
    expect(resolvePurpose("Moody")).toBe("horror/story recap");
    expect(resolvePurpose("Corporate")).toBe("product promotion");
    expect(resolvePurpose("Cinematic")).toBe("documentary");
    expect(resolvePurpose("Playful")).toBe("social/news");
    expect(resolvePurpose("Urgent")).toBe("motivation");
    expect(resolvePurpose("Educational")).toBe("educational");
    expect(resolvePurpose("Storyteller")).toBe("storytelling");
    expect(resolvePurpose("Luxurious")).toBe("product promotion");
    expect(resolvePurpose("UnknownTone")).toBe("storytelling");
    expect(PURPOSE_BY_TONE).toHaveProperty("Educational", "educational");
  });
});
