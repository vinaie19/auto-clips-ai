/**
 * Pexels B-roll: one clip per spoken script line (line-bound beats).
 */

const PEXELS_VIDEO_SEARCH_URL = "https://api.pexels.com/v1/videos/search";

export const MAX_VISUAL_BEATS = 8;
export const MIN_VISUAL_BEATS = 4;

/**
 * Prefer 720–1080p mp4; bias toward preferred orientation.
 * @param {unknown[]} videoFiles
 * @param {"portrait" | "landscape" | "square" | undefined} preferred
 */
export function pickOptimalMp4(videoFiles, preferred) {
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
    let orientBonus = 0;
    if (preferred === "portrait") orientBonus = h > w ? 1000 : 0;
    else if (preferred === "landscape") orientBonus = w > h ? 1000 : 0;
    else if (preferred === "square") orientBonus = Math.abs(w - h) < w * 0.15 ? 1000 : 0;
    else orientBonus = h > w ? 500 : 0;
    const near1080 = -Math.abs(Math.max(w, h) - 1080);
    return orientBonus + near1080;
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
 * Prefer unused URLs; if all hits are already used, allow reuse of a hit
 * (better continuity than inventing an unrelated clip).
 */
async function resolveUrlForQuery(apiKey, query, usedUrls, preferredOrientation) {
  const q = String(query || "").trim();
  if (!q) return null;

  let firstHit = null;
  const pexelsOrientation =
    preferredOrientation === "square"
      ? undefined
      : preferredOrientation === "landscape"
        ? "landscape"
        : preferredOrientation === "portrait"
          ? "portrait"
          : "portrait";

  const tryOrder = [
    pexelsOrientation,
    pexelsOrientation === "portrait" ? "landscape" : "portrait",
    undefined,
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  for (const orientation of tryOrder) {
    const videos = await searchPexelsOnce(apiKey, q, { orientation });
    for (const video of videos) {
      const link = pickOptimalMp4(video?.video_files, preferredOrientation);
      if (!link) continue;
      if (!firstHit) firstHit = link;
      if (!usedUrls.has(link)) {
        usedUrls.add(link);
        return link;
      }
    }
  }

  return firstHit;
}

/**
 * Map line-bound visual beat queries → Pexels URLs (ordered).
 * On miss: reuse previous beat URL (never pad with unrelated stock).
 *
 * @param {string[]} queries
 * @param {{ weights?: number[], lines?: string[], motif?: string, orientation?: string }} [opts]
 * @returns {Promise<{ pexelsVideoUrls: string[], visualBeats: { query: string, url: string, weight: number, line: string | null }[], motif: string | null }>}
 */
export async function fetchBrollForQueries(queries, opts = {}) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey || apiKey === "your_pexels_key_here") {
    throw new Error("PEXELS_API_KEY is not configured on the server.");
  }

  const weights = Array.isArray(opts.weights) ? opts.weights : [];
  const lines = Array.isArray(opts.lines) ? opts.lines : [];
  const motif = typeof opts.motif === "string" ? opts.motif : null;
  const preferredOrientation =
    opts.orientation === "landscape" ||
    opts.orientation === "portrait" ||
    opts.orientation === "square"
      ? opts.orientation
      : "portrait";

  const cleaned = queries
    .map((q) => String(q || "").trim())
    .filter(Boolean)
    .slice(0, MAX_VISUAL_BEATS);

  if (cleaned.length === 0) {
    throw new Error("No visual search queries generated.");
  }

  const usedUrls = new Set();
  const visualBeats = [];
  let lastGoodUrl = null;

  for (let i = 0; i < cleaned.length; i++) {
    const query = cleaned[i];
    let url = await resolveUrlForQuery(
      apiKey,
      query,
      usedUrls,
      preferredOrientation
    );

    if (!url && lastGoodUrl) {
      url = lastGoodUrl;
    }

    if (!url && motif) {
      url = await resolveUrlForQuery(
        apiKey,
        motif,
        usedUrls,
        preferredOrientation
      );
    }

    if (url) {
      lastGoodUrl = url;
      const weight = Number(weights[i]);
      const line =
        typeof lines[i] === "string" && lines[i].trim() ? lines[i].trim() : null;
      visualBeats.push({
        query,
        url,
        line,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      });
    }
  }

  if (visualBeats.length === 0) {
    throw new Error("Failed to fetch any related B-roll clips from Pexels.");
  }

  // Prefer at least MIN beats by extending last URL if planner returned few hits
  while (visualBeats.length < Math.min(MIN_VISUAL_BEATS, cleaned.length) && lastGoodUrl) {
    const last = visualBeats[visualBeats.length - 1];
    visualBeats.push({
      query: last.query,
      url: lastGoodUrl,
      line: last.line,
      weight: last.weight,
    });
  }

  return {
    pexelsVideoUrls: visualBeats.map((b) => b.url),
    visualBeats,
    motif,
  };
}
