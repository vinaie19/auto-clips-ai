/**
 * Pexels B-roll helpers: pick files + search per visual query.
 */

const PEXELS_VIDEO_SEARCH_URL = "https://api.pexels.com/v1/videos/search";

const PEXELS_FALLBACK_CLIPS = [
  "https://videos.pexels.com/video-files/5532763/5532763-uhd_1440_2732_25fps.mp4",
  "https://videos.pexels.com/video-files/3045163/3045163-uhd_2560_1440_30fps.mp4",
];

export const MAX_VISUAL_BEATS = 10;
export const MIN_VISUAL_BEATS = 5;

/**
 * Prefer 720–1080p mp4; portrait first, then any orientation.
 */
export function pickOptimalMp4(videoFiles) {
  const files = (videoFiles || []).filter((file) => {
    const link = typeof file?.link === "string" ? file.link : "";
    const width = Number(file?.width) || 0;
    const isMp4 =
      file?.file_type === "video/mp4" || link.toLowerCase().includes(".mp4");
    return isMp4 && width >= 640 && width <= 1920;
  });

  const score = (file) => {
    const w = Number(file.width) || 0;
    const h = Number(file.height) || 0;
    const portrait = h > w ? 1000 : 0;
    const near1080 = -Math.abs(w - 1080);
    return portrait + near1080;
  };

  files.sort((a, b) => score(b) - score(a));
  return files[0]?.link || null;
}

async function searchPexelsOnce(apiKey, query, { orientation } = {}) {
  const params = new URLSearchParams({
    query,
    per_page: "8",
  });
  if (orientation) params.set("orientation", orientation);

  const response = await fetch(`${PEXELS_VIDEO_SEARCH_URL}?${params}`, {
    method: "GET",
    headers: { Authorization: apiKey },
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Pexels search error:", query, detail.slice(0, 200));
    return [];
  }

  const data = await response.json();
  return Array.isArray(data?.videos) ? data.videos : [];
}

/**
 * For one visual query, return first unused mp4 URL.
 */
async function resolveUrlForQuery(apiKey, query, usedUrls) {
  const q = String(query || "").trim();
  if (!q) return null;

  for (const orientation of ["portrait", "landscape", undefined]) {
    const videos = await searchPexelsOnce(apiKey, q, { orientation });
    for (const video of videos) {
      const link = pickOptimalMp4(video?.video_files);
      if (link && !usedUrls.has(link)) {
        usedUrls.add(link);
        return link;
      }
    }
  }
  return null;
}

/**
 * Map visual beat queries → distinct Pexels URLs (ordered).
 * Avoids padding with unrelated stock; only uses fallback if a beat finds nothing.
 *
 * @param {string[]} queries
 * @returns {Promise<{ pexelsVideoUrls: string[], visualBeats: { query: string, url: string }[] }>}
 */
export async function fetchBrollForQueries(queries) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey || apiKey === "your_pexels_key_here") {
    throw new Error("PEXELS_API_KEY is not configured on the server.");
  }

  const cleaned = queries
    .map((q) => String(q || "").trim())
    .filter(Boolean)
    .slice(0, MAX_VISUAL_BEATS);

  if (cleaned.length === 0) {
    throw new Error("No visual search queries generated.");
  }

  const usedUrls = new Set();
  const visualBeats = [];
  let fallbackIdx = 0;

  for (const query of cleaned) {
    let url = await resolveUrlForQuery(apiKey, query, usedUrls);
    if (!url) {
      // Last resort: one topic-agnostic fallback, still unique when possible
      while (fallbackIdx < PEXELS_FALLBACK_CLIPS.length) {
        const fb = PEXELS_FALLBACK_CLIPS[fallbackIdx];
        fallbackIdx += 1;
        if (!usedUrls.has(fb)) {
          url = fb;
          usedUrls.add(fb);
          break;
        }
      }
    }
    if (url) {
      visualBeats.push({ query, url });
    }
  }

  if (visualBeats.length === 0) {
    throw new Error("Failed to fetch any related B-roll clips from Pexels.");
  }

  return {
    pexelsVideoUrls: visualBeats.map((b) => b.url),
    visualBeats,
  };
}
