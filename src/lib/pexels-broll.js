/**
 * Pexels B-roll: one clip per spoken script line (line-bound beats).
 * gpt-4o-mini vision verifies stills with a small retry budget (speed-first).
 */

import { verifyClipAgainstLine } from "@/lib/clip-verify";

const PEXELS_VIDEO_SEARCH_URL = "https://api.pexels.com/v1/videos/search";

export const MAX_VISUAL_BEATS = 15;
export const MIN_VISUAL_BEATS = 4;
/** Pexels hits to try per search query before a betterQuery round. */
export const MAX_VERIFY_CANDIDATES = 5;
/** Max vision API calls per beat (keep generate fast). */
export const MAX_VISION_ATTEMPTS = 2;
/** Max distinct Pexels search queries per beat (initial + one betterQuery). */
export const MAX_QUERY_ROUNDS = 2;
/** Extra unused clips to grab when vision path finds nothing (no reuse of prior beat). */
export const MAX_FALLBACK_CANDIDATES = 8;

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

/** Best preview image URL from a Pexels video object. */
export function pickPreviewImage(video) {
  if (typeof video?.image === "string" && video.image.startsWith("http")) {
    return video.image;
  }
  const pics = Array.isArray(video?.video_pictures) ? video.video_pictures : [];
  for (const p of pics) {
    if (typeof p?.picture === "string" && p.picture.startsWith("http")) {
      return p.picture;
    }
  }
  return null;
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

function orientationTryOrder(preferredOrientation) {
  const pexelsOrientation =
    preferredOrientation === "square"
      ? undefined
      : preferredOrientation === "landscape"
        ? "landscape"
        : preferredOrientation === "portrait"
          ? "portrait"
          : "portrait";

  return [
    pexelsOrientation,
    pexelsOrientation === "portrait" ? "landscape" : "portrait",
    undefined,
  ].filter((v, i, arr) => arr.indexOf(v) === i);
}

/**
 * Collect unused mp4 + preview candidates for a query (does not mutate usedUrls).
 * @returns {Promise<{ url: string, imageUrl: string | null }[]>}
 */
async function collectClipCandidates(
  apiKey,
  query,
  usedUrls,
  preferredOrientation,
  limit = MAX_VERIFY_CANDIDATES
) {
  const q = String(query || "").trim();
  if (!q) return [];

  /** @type {{ url: string, imageUrl: string | null }[]} */
  const out = [];
  const seen = new Set();

  for (const orientation of orientationTryOrder(preferredOrientation)) {
    if (out.length >= limit) break;
    const videos = await searchPexelsOnce(apiKey, q, { orientation });
    for (const video of videos) {
      if (out.length >= limit) break;
      const link = pickOptimalMp4(video?.video_files, preferredOrientation);
      if (!link || usedUrls.has(link) || seen.has(link)) continue;
      seen.add(link);
      out.push({ url: link, imageUrl: pickPreviewImage(video) });
    }
  }

  return out;
}

/**
 * Pick clip and vision-verify vs spoken line.
 * Retries a few candidates + one betterQuery round, or keeps best still.
 * Rejected candidates stay reusable for later beats (not added to usedUrls).
 * @returns {Promise<{ url: string, query: string, verified: boolean, retried: boolean } | null>}
 */
export async function resolveVerifiedClip({
  apiKey,
  query,
  line,
  usedUrls,
  preferredOrientation,
}) {
  const initialQuery = String(query || "").trim();
  if (!initialQuery) return null;

  const spoken = String(line || "").trim() || initialQuery;
  const triedQueries = new Set();
  /** URLs already judged this beat (rejects) — keep out of usedUrls until accept. */
  const triedUrls = new Set();
  let searchQuery = initialQuery;
  let visionAttempts = 0;
  let queryRounds = 0;
  let lastBetterQuery = null;

  /** @type {{ url: string, query: string, score: number } | null} */
  let bestRejected = null;

  const lineFallback = `${spoken.split(/\s+/).slice(0, 5).join(" ")}`.trim();

  while (
    visionAttempts < MAX_VISION_ATTEMPTS &&
    queryRounds < MAX_QUERY_ROUNDS
  ) {
    const qKey = searchQuery.toLowerCase();
    if (triedQueries.has(qKey)) break;
    triedQueries.add(qKey);
    queryRounds += 1;

    const blocked = new Set([...usedUrls, ...triedUrls]);
    const candidates = await collectClipCandidates(
      apiKey,
      searchQuery,
      blocked,
      preferredOrientation,
      MAX_VERIFY_CANDIDATES
    );

    if (candidates.length === 0) {
      const next =
        lastBetterQuery &&
        !triedQueries.has(lastBetterQuery.toLowerCase())
          ? lastBetterQuery
          : lineFallback && !triedQueries.has(lineFallback.toLowerCase())
            ? lineFallback
            : null;
      if (!next) break;
      searchQuery = next;
      continue;
    }

    for (const hit of candidates) {
      if (visionAttempts >= MAX_VISION_ATTEMPTS) break;
      if (triedUrls.has(hit.url) || usedUrls.has(hit.url)) continue;

      if (!hit.imageUrl) {
        usedUrls.add(hit.url);
        return {
          url: hit.url,
          query: searchQuery,
          verified: false,
          retried: queryRounds > 1 || visionAttempts > 0,
        };
      }

      visionAttempts += 1;
      triedUrls.add(hit.url);
      const verdict = await verifyClipAgainstLine({
        line: spoken,
        query: searchQuery,
        imageUrl: hit.imageUrl,
      });

      if (verdict.betterQuery) {
        lastBetterQuery = verdict.betterQuery.trim();
      }

      if (verdict.match) {
        usedUrls.add(hit.url);
        console.log(
          JSON.stringify({
            event: "clip_verify_match",
            line: spoken.slice(0, 80),
            query: searchQuery,
            score: verdict.score,
            attempts: visionAttempts,
            rounds: queryRounds,
          })
        );
        return {
          url: hit.url,
          query: searchQuery,
          verified: true,
          retried: visionAttempts > 1 || queryRounds > 1,
        };
      }

      if (!bestRejected || verdict.score >= bestRejected.score) {
        bestRejected = {
          url: hit.url,
          query: searchQuery,
          score: verdict.score,
        };
      }

      console.log(
        JSON.stringify({
          event: "clip_verify_reject",
          line: spoken.slice(0, 80),
          query: searchQuery,
          score: verdict.score,
          reason: verdict.reason,
          attempts: visionAttempts,
        })
      );
    }

    const nextQuery =
      lastBetterQuery && !triedQueries.has(lastBetterQuery.toLowerCase())
        ? lastBetterQuery
        : lineFallback && !triedQueries.has(lineFallback.toLowerCase())
          ? lineFallback
          : null;

    if (!nextQuery) break;

    console.log(
      JSON.stringify({
        event: "clip_verify_retry",
        line: spoken.slice(0, 80),
        from: searchQuery,
        to: nextQuery,
        attempts: visionAttempts,
        rounds: queryRounds,
      })
    );
    searchQuery = nextQuery;
  }

  if (bestRejected && !usedUrls.has(bestRejected.url)) {
    usedUrls.add(bestRejected.url);
    console.log(
      JSON.stringify({
        event: "clip_verify_keep_best",
        line: spoken.slice(0, 80),
        query: bestRejected.query,
        score: bestRejected.score,
        attempts: visionAttempts,
        rounds: queryRounds,
      })
    );
    return {
      url: bestRejected.url,
      query: bestRejected.query,
      verified: false,
      retried: true,
    };
  }

  return null;
}

/**
 * First unused mp4 for a query (no vision) — keeps cuts visually distinct.
 * @returns {Promise<{ url: string, query: string, verified: boolean, retried: boolean } | null>}
 */
export async function pickUnusedClip({
  apiKey,
  query,
  usedUrls,
  preferredOrientation,
  limit = MAX_FALLBACK_CANDIDATES,
}) {
  const q = String(query || "").trim();
  if (!q) return null;
  const candidates = await collectClipCandidates(
    apiKey,
    q,
    usedUrls,
    preferredOrientation,
    limit
  );
  const hit = candidates.find((c) => c.url && !usedUrls.has(c.url));
  if (!hit) return null;
  usedUrls.add(hit.url);
  return {
    url: hit.url,
    query: q,
    verified: false,
    retried: true,
  };
}

/**
 * Map line-bound visual beat queries → Pexels URLs (ordered).
 * Prefers unique URLs per beat — never reuses the previous beat's clip.
 *
 * @param {string[]} queries
 * @param {{ weights?: number[], lines?: string[], motif?: string, orientation?: string }} [opts]
 * @returns {Promise<{ pexelsVideoUrls: string[], visualBeats: { query: string, url: string, weight: number, line: string | null, verified?: boolean, retried?: boolean }[], motif: string | null }>}
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

  for (let i = 0; i < cleaned.length; i++) {
    const query = cleaned[i];
    const line =
      typeof lines[i] === "string" && lines[i].trim() ? lines[i].trim() : null;
    const lineFallback = line
      ? line.split(/\s+/).slice(0, 5).join(" ").trim()
      : "";

    let resolved = await resolveVerifiedClip({
      apiKey,
      query,
      line,
      usedUrls,
      preferredOrientation,
    });

    if (!resolved?.url && motif) {
      resolved = await resolveVerifiedClip({
        apiKey,
        query: motif,
        line: line || motif,
        usedUrls,
        preferredOrientation,
      });
    }

    // Unique unused clip only — never reuse the previous beat's URL.
    if (!resolved?.url) {
      const fallbackQueries = [query, lineFallback, motif].filter(
        (q, idx, arr) => q && arr.indexOf(q) === idx
      );
      for (const fq of fallbackQueries) {
        resolved = await pickUnusedClip({
          apiKey,
          query: fq,
          usedUrls,
          preferredOrientation,
        });
        if (resolved?.url) {
          console.log(
            JSON.stringify({
              event: "clip_unique_fallback",
              index: i,
              query: fq,
              line: (line || "").slice(0, 80),
            })
          );
          break;
        }
      }
    }

    if (resolved?.url) {
      const weight = Number(weights[i]);
      visualBeats.push({
        query: resolved.query || query,
        url: resolved.url,
        line,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
        verified: Boolean(resolved.verified),
        retried: Boolean(resolved.retried),
      });
    } else {
      console.log(
        JSON.stringify({
          event: "clip_beat_skipped",
          index: i,
          query,
          line: (line || "").slice(0, 80),
        })
      );
    }
  }

  if (visualBeats.length === 0) {
    throw new Error("Failed to fetch any related B-roll clips from Pexels.");
  }

  if (visualBeats.length < Math.min(MIN_VISUAL_BEATS, cleaned.length)) {
    const err = new Error(
      `Only found ${visualBeats.length} unique B-roll clips (need ${MIN_VISUAL_BEATS}).`
    );
    err.status = 502;
    throw err;
  }

  const uniqueCount = new Set(visualBeats.map((b) => b.url)).size;
  console.log(
    JSON.stringify({
      event: "broll_unique_summary",
      beats: visualBeats.length,
      unique_urls: uniqueCount,
      queries: cleaned.length,
    })
  );

  return {
    pexelsVideoUrls: visualBeats.map((b) => b.url),
    visualBeats,
    motif,
  };
}

/** @param {{ url?: string }[]} beats */
export function countUniqueBeatUrls(beats) {
  return new Set(
    (Array.isArray(beats) ? beats : [])
      .map((b) => b?.url)
      .filter((u) => typeof u === "string" && u.length > 0)
  ).size;
}
