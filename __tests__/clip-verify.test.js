import { describe, expect, it } from "vitest";
import {
  normalizeClipVerdict,
  CLIP_MATCH_THRESHOLD,
  CLIP_VERIFY_MODEL,
} from "@/lib/clip-verify";
import { pickPreviewImage, pickOptimalMp4 } from "@/lib/pexels-broll";

describe("normalizeClipVerdict", () => {
  it("uses gpt-4o-mini with a practical match threshold", () => {
    expect(CLIP_MATCH_THRESHOLD).toBeGreaterThanOrEqual(0.55);
    expect(CLIP_MATCH_THRESHOLD).toBeLessThanOrEqual(0.7);
    expect(CLIP_VERIFY_MODEL).toBe("gpt-4o-mini");
  });

  it("accepts high scores as match", () => {
    const v = normalizeClipVerdict({
      match: true,
      score: 0.9,
      reason: "shows coffee pour",
      betterQuery: null,
    });
    expect(v.match).toBe(true);
    expect(v.score).toBe(0.9);
  });

  it("rejects mid scores below the match threshold", () => {
    const v = normalizeClipVerdict({
      match: true,
      score: 0.4,
      reason: "weak match",
      betterQuery: "bodyweight push ups floor",
    });
    expect(v.match).toBe(false);
    expect(v.betterQuery).toBe("bodyweight push ups floor");
  });

  it("rejects low scores even if match true", () => {
    const v = normalizeClipVerdict({
      match: true,
      score: 0.2,
      reason: "wrong subject",
      betterQuery: "whisk eggs bowl",
    });
    expect(v.match).toBe(false);
    expect(v.betterQuery).toBe("whisk eggs bowl");
    expect(CLIP_MATCH_THRESHOLD).toBeGreaterThan(0.2);
  });

  it("treats unparseable verdicts as mismatch so callers can retry", () => {
    const v = normalizeClipVerdict("not-json{{{");
    expect(v.match).toBe(false);
    expect(v.score).toBeLessThan(CLIP_MATCH_THRESHOLD);
  });

  it("parses JSON strings and clamps score", () => {
    const v = normalizeClipVerdict(
      JSON.stringify({ match: false, score: 1.5, reason: "x", betterQuery: "pan heat" })
    );
    expect(v.score).toBe(1);
    expect(v.match).toBe(false);
    expect(v.betterQuery).toBe("pan heat");
  });
});

describe("pickPreviewImage", () => {
  it("prefers video.image", () => {
    expect(
      pickPreviewImage({
        image: "https://images.pexels.com/a.jpg",
        video_pictures: [{ picture: "https://images.pexels.com/b.jpg" }],
      })
    ).toBe("https://images.pexels.com/a.jpg");
  });

  it("falls back to video_pictures", () => {
    expect(
      pickPreviewImage({
        video_pictures: [{ picture: "https://images.pexels.com/b.jpg" }],
      })
    ).toBe("https://images.pexels.com/b.jpg");
  });
});

describe("pickOptimalMp4 still works", () => {
  it("prefers portrait", () => {
    const link = pickOptimalMp4(
      [
        {
          file_type: "video/mp4",
          width: 1920,
          height: 1080,
          link: "https://example.com/land.mp4",
        },
        {
          file_type: "video/mp4",
          width: 1080,
          height: 1920,
          link: "https://example.com/port.mp4",
        },
      ],
      "portrait"
    );
    expect(link).toBe("https://example.com/port.mp4");
  });
});
