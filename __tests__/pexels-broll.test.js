import { describe, expect, it } from "vitest";
import {
  pickOptimalMp4,
  MAX_VISUAL_BEATS,
  MIN_VISUAL_BEATS,
} from "@/lib/pexels-broll";

describe("pickOptimalMp4", () => {
  it("prefers portrait near 1080p", () => {
    const link = pickOptimalMp4([
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
    ]);
    expect(link).toBe("https://example.com/port.mp4");
  });
});

describe("visual beat limits", () => {
  it("caps continuity edits at 3–5 shots", () => {
    expect(MIN_VISUAL_BEATS).toBe(3);
    expect(MAX_VISUAL_BEATS).toBe(5);
  });
});
