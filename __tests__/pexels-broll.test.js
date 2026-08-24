import {
  pickOptimalMp4,
  MAX_VISUAL_BEATS,
  MIN_VISUAL_BEATS,
  MAX_VERIFY_CANDIDATES,
  MAX_VISION_ATTEMPTS,
  MAX_QUERY_ROUNDS,
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
  it("allows more continuity edits per motif", () => {
    expect(MIN_VISUAL_BEATS).toBe(4);
    expect(MAX_VISUAL_BEATS).toBe(15);
  });

  it("keeps a small retry budget for faster generate", () => {
    expect(MAX_VISION_ATTEMPTS).toBeLessThanOrEqual(4);
    expect(MAX_VERIFY_CANDIDATES).toBeLessThanOrEqual(3);
    expect(MAX_QUERY_ROUNDS).toBeLessThanOrEqual(2);
  });
});
