import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  providerOrderForStyle,
  toProviderParams,
  toAsset,
  clearProviderSearchCache,
  SEARCH_CACHE_TTL_MS,
  MAX_STYLE_RETRIES,
  MAX_VISION_CALLS_PER_RENDER,
  MIN_VISUAL_BEATS,
  KEEP_BEST_MIN_SCORE,
  isPlausibleStockQuery,
  fetchBrollForQueries,
} from "@/lib/pexels-broll";
import { searchCandidates } from "@/lib/broll-providers";
import {
  normalizeVisualStyle,
  normalizePurpose,
} from "@/lib/video-taxonomy";
import {
  normalizeClipVerdict,
  STYLE_MATCH_THRESHOLD,
} from "@/lib/clip-verify";
import { hardenStockQuery } from "@/lib/visual-queries";

afterEach(() => {
  clearProviderSearchCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PIXABAY_API_KEY;
  delete process.env.PEXELS_API_KEY;
  delete process.env.CLIP_VERIFY;
});

describe("providerOrderForStyle (D5)", () => {
  it("routes animated tier to Pixabay first with animation", () => {
    for (const style of [
      "cartoon",
      "2d animation",
      "3d animation",
      "motion graphics",
      "anime/comic",
    ]) {
      expect(providerOrderForStyle(style)).toEqual(["pixabay", "pexels"]);
    }
  });

  it("routes realistic/cinematic/horror to Pexels first", () => {
    for (const style of ["realistic", "cinematic", "horror/dark", "minimal"]) {
      expect(providerOrderForStyle(style)).toEqual(["pexels", "pixabay"]);
    }
  });
});

describe("normalizeVisualStyle / normalizePurpose (F7)", () => {
  it("returns null for unset style so purpose fallback can fire", () => {
    expect(normalizeVisualStyle(undefined)).toBeNull();
    expect(normalizeVisualStyle("cartoon")).toBe("cartoon");
    expect(normalizeVisualStyle("bogus")).toBeNull();
  });

  it("falls back purpose to storytelling", () => {
    expect(normalizePurpose(undefined)).toBe("storytelling");
    expect(normalizePurpose("documentary")).toBe("documentary");
  });
});

describe("toProviderParams orientation adapter (F10)", () => {
  it("maps portrait to Pexels orientation and Pixabay min dims (never orientation=portrait)", () => {
    expect(toProviderParams("portrait", "pexels")).toMatchObject({
      params: { orientation: "portrait" },
      mode: "params",
    });
    const pix = toProviderParams("portrait", "pixabay");
    expect(pix.mode).toBe("dim-filter");
    expect(pix.params).not.toHaveProperty("orientation");
    expect(pix.params.min_height).toBe("1280");
  });

  it("omits orientation for square on Pexels", () => {
    expect(toProviderParams("square", "pexels").params).toEqual({});
  });
});

describe("toAsset", () => {
  it("normalizes Pexels and Pixabay hits", () => {
    const pexels = toAsset(
      {
        id: 11,
        image: "https://images.pexels.com/a.jpg",
        video_files: [
          {
            file_type: "video/mp4",
            width: 1080,
            height: 1920,
            link: "https://pexels.example/a.mp4",
          },
        ],
      },
      "pexels",
      "portrait"
    );
    expect(pexels).toMatchObject({
      provider: "pexels",
      providerAssetId: "11",
      url: "https://pexels.example/a.mp4",
    });

    const pixabay = toAsset(
      {
        id: 99,
        picture_id: "abc123",
        videos: {
          large: {
            url: "https://pixabay.example/a.mp4",
            width: 1080,
            height: 1920,
          },
        },
      },
      "pixabay",
      "portrait",
      "dim-filter"
    );
    expect(pixabay).toMatchObject({
      provider: "pixabay",
      providerAssetId: "99",
      url: "https://pixabay.example/a.mp4",
    });
    expect(pixabay.imageUrl).toContain("abc123");
  });
});

describe("styleMatch verdict (D6)", () => {
  it("returns independent styleMatch when style was requested", () => {
    const v = normalizeClipVerdict(
      { match: true, score: 0.9, styleScore: 0.2, reason: "live action" },
      { styleRequested: true }
    );
    expect(v.match).toBe(true);
    expect(v.styleMatch).toBe(false);
    expect(v.styleScore).toBe(0.2);
    expect(STYLE_MATCH_THRESHOLD).toBe(0.4);
  });

  it("returns null style fields when style was not requested", () => {
    const v = normalizeClipVerdict({
      match: true,
      score: 0.9,
      reason: "ok",
    });
    expect(v.match).toBe(true);
    expect(v.styleMatch).toBeNull();
    expect(v.styleScore).toBeNull();
  });
});

describe("hardenStockQuery style vocab (T5)", () => {
  it("appends style vocab for vague queries when style is set", () => {
    const q = hardenStockQuery("intensity", "the dog runs fast", "pets", "cartoon");
    expect(q.toLowerCase()).toMatch(/cartoon|dog|runs/);
  });

  it("leaves concrete queries alone when style is set", () => {
    expect(
      hardenStockQuery("close up coffee pour", "pour the coffee", "coffee", "cartoon")
    ).toBe("close up coffee pour");
  });
});

describe("style budgets", () => {
  it("exports style retry and vision call caps", () => {
    expect(MAX_STYLE_RETRIES).toBe(2);
    expect(MAX_VISION_CALLS_PER_RENDER).toBe(30);
    expect(MIN_VISUAL_BEATS).toBe(4);
    expect(KEEP_BEST_MIN_SCORE).toBe(0.35);
  });
});

describe("isPlausibleStockQuery", () => {
  it("accepts concrete stock phrases and rejects narration fragments", () => {
    expect(isPlausibleStockQuery("elephant walking savannah")).toBe(true);
    expect(isPlausibleStockQuery("close up elephant trunk")).toBe(true);
    expect(isPlausibleStockQuery("So, next time you see")).toBe(false);
    expect(isPlausibleStockQuery("You might wonder about their")).toBe(false);
    expect(isPlausibleStockQuery("Because he wanted to pack")).toBe(false);
    expect(isPlausibleStockQuery("")).toBe(false);
  });
});

function mockPexelsHit(id, url) {
  return {
    id,
    image: `https://images.pexels.com/${id}.jpg`,
    video_files: [
      {
        file_type: "video/mp4",
        width: 1080,
        height: 1920,
        link: url,
      },
    ],
  };
}

function mockPixabayHit(id, url) {
  return {
    id,
    picture_id: `pic${id}`,
    videos: {
      large: { url, width: 1080, height: 1920, thumbnail: `https://t/${id}.jpg` },
    },
  };
}

describe("fetchBrollForQueries seam (D11)", () => {
  beforeEach(() => {
    process.env.PEXELS_API_KEY = "test-pexels";
    process.env.PIXABAY_API_KEY = "test-pixabay";
    process.env.CLIP_VERIFY = "0";
    clearProviderSearchCache();
  });

  it("hits Pixabay animation first for cartoon and returns provider fields", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("pixabay.com")) {
        expect(url).not.toContain("orientation=portrait");
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            "X-RateLimit-Remaining": "90",
            "X-RateLimit-Limit": "100",
          }),
          json: async () => ({
            hits: [
              mockPixabayHit(1, "https://cdn.pixabay.com/v1.mp4"),
              mockPixabayHit(2, "https://cdn.pixabay.com/v2.mp4"),
              mockPixabayHit(3, "https://cdn.pixabay.com/v3.mp4"),
              mockPixabayHit(4, "https://cdn.pixabay.com/v4.mp4"),
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          "X-Ratelimit-Remaining": "100",
          "X-Ratelimit-Limit": "200",
        }),
        json: async () => ({ videos: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBrollForQueries(
      [
        "cartoon dog running",
        "cartoon cat jump",
        "cartoon bird fly",
        "cartoon fish swim",
      ],
      { visualStyle: "cartoon", orientation: "portrait" }
    );

    expect(result.visualBeats.length).toBeGreaterThanOrEqual(MIN_VISUAL_BEATS);
    expect(
      result.visualBeats.every((b) => b.provider && b.providerAssetId)
    ).toBe(true);
    expect(result.visualBeats.some((b) => b.provider === "pixabay")).toBe(true);
    expect(typeof result.styleDegraded).toBe("boolean");
    expect(
      result.styleAcceptanceRate === null ||
        typeof result.styleAcceptanceRate === "number"
    ).toBe(true);

    const pixabayAnim = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("video_type=animation")
    );
    expect(pixabayAnim.length).toBeGreaterThan(0);
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    expect(firstUrl).toContain("pixabay.com");
  });

  it("degrades to Pexels when Pixabay key is missing (D12)", async () => {
    delete process.env.PIXABAY_API_KEY;
    const fetchMock = vi.fn(async () => {
      const id = fetchMock.mock.calls.length;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "X-Ratelimit-Remaining": "50" }),
        json: async () => ({
          videos: [
            mockPexelsHit(id, `https://cdn.pexels.com/v${id}.mp4`),
            mockPexelsHit(id + 100, `https://cdn.pexels.com/v${id + 100}.mp4`),
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBrollForQueries(["a", "b", "c", "d"], {
      visualStyle: "cartoon",
    });
    expect(result.visualBeats.length).toBeGreaterThanOrEqual(4);
    expect(result.visualBeats.every((b) => b.provider === "pexels")).toBe(true);
    expect(
      fetchMock.mock.calls.every((c) => !String(c[0]).includes("pixabay.com"))
    ).toBe(true);
  });

  it("caches identical searches for 24h without a second network call", async () => {
    process.env.PIXABAY_API_KEY = "test-pixabay";
    let calls = 0;
    vi.stubGlobal("fetch", async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes("pixabay")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "X-RateLimit-Remaining": "90" }),
          json: async () => ({
            hits: [mockPixabayHit(1, "https://cdn.pixabay.com/cached.mp4")],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "X-Ratelimit-Remaining": "90" }),
        json: async () => ({ videos: [] }),
      };
    });

    await searchCandidates("coffee", { orientation: "portrait" }, "pixabay");
    await searchCandidates("coffee", { orientation: "portrait" }, "pixabay");
    expect(calls).toBe(1);
    expect(SEARCH_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("fills failed line searches from the motif bank (theme continuity)", async () => {
    let motifHit = 0;
    vi.stubGlobal("fetch", async (input) => {
      const url = String(input);
      const isMotif =
        url.includes("elephants") ||
        decodeURIComponent(url).includes("elephants");
      if (url.includes("pixabay.com")) {
        // Line queries on Pixabay: empty (forces miss for 3d animation path)
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "X-RateLimit-Remaining": "90" }),
          json: async () => ({ hits: [] }),
        };
      }
      // Pexels: only motif searches return clips
      if (isMotif) {
        motifHit += 1;
        const id = motifHit;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "X-Ratelimit-Remaining": "90" }),
          json: async () => ({
            videos: [
              mockPexelsHit(id, `https://cdn.pexels.com/elephant-${id}.mp4`),
              mockPexelsHit(
                id + 50,
                `https://cdn.pexels.com/elephant-${id + 50}.mp4`
              ),
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "X-Ratelimit-Remaining": "90" }),
        json: async () => ({ videos: [] }),
      };
    });

    const result = await fetchBrollForQueries(
      [
        "suitcase party abstract xyz",
        "scale weighing nonsense abc",
        "social structure icons qwe",
        "snow trees winter rty",
      ],
      {
        visualStyle: "3d animation",
        motif: "elephants walking savannah",
        orientation: "portrait",
      }
    );

    expect(result.visualBeats.length).toBeGreaterThanOrEqual(MIN_VISUAL_BEATS);
    expect(
      result.visualBeats.every((b) => b.url.includes("elephant"))
    ).toBe(true);
    expect(result.visualBeats.some((b) => b.fromMotifBank === true)).toBe(true);
    expect(result.styleDegraded).toBe(true);
  });
});
