/**
 * Stock video providers (Pexels + Pixabay) behind a shared searchCandidates seam.
 */

import { isStrictStyleTier } from "./video-taxonomy.js";

const PEXELS_VIDEO_SEARCH_URL = "https://api.pexels.com/v1/videos/search";
const PIXABAY_VIDEO_SEARCH_URL = "https://pixabay.com/api/videos/";

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
    else if (preferred === "square")
      orientBonus = Math.abs(w - h) < w * 0.15 ? 1000 : 0;
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

export const PROVIDER_REMAINING_FLOOR = 5;
/** Pixabay documented ~100 req/60s; pace to ≤ 1 req/s. */
export const PIXABAY_MIN_GAP_MS = 1000;
/** Pixabay: "requests must be cached for 24 hours". */
export const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, { expires: number, value: object }>} */
const searchCache = new Map();

/** @type {Map<string, { lastAt: number, backoffUntil: number }>} */
const rateState = new Map();

/**
 * Per-render media dedupe: providerAssetId → local tmp path.
 * @returns {Map<string, string>}
 */
export function createRenderMediaCache() {
  return new Map();
}

/** @deprecated alias — same as createRenderMediaCache */
export function createMediaCache() {
  return createRenderMediaCache();
}

export function getPexelsApiKey() {
  const key = process.env.PEXELS_API_KEY;
  if (!key || key === "your_pexels_key_here") return null;
  return key;
}

/**
 * Map internal orientation → provider-specific search params.
 * Pixabay videos API has no orientation filter (images API does); use
 * min_width/min_height + client-side dim-filter on videos[].large.
 *
 * @param {"portrait" | "landscape" | "square" | undefined} orientation
 * @param {"pexels" | "pixabay"} provider
 * @returns {{ params: Record<string, string>, mode: "params" | "dim-filter", adapter: "params" | "dim-filter", prefer: "portrait" | "landscape" | "square" | undefined }}
 */
export function toProviderParams(orientation, provider) {
  const prefer =
    orientation === "landscape" ||
    orientation === "portrait" ||
    orientation === "square"
      ? orientation
      : "portrait";

  if (provider === "pexels") {
    if (prefer === "square") {
      return { params: {}, mode: "params", adapter: "params", prefer };
    }
    return {
      params: { orientation: prefer },
      mode: "params",
      adapter: "params",
      prefer,
    };
  }

  // Pixabay videos: no orientation param — use size hints + dim-filter.
  if (prefer === "portrait") {
    return {
      params: { min_width: "720", min_height: "1280" },
      mode: "dim-filter",
      adapter: "dim-filter",
      prefer,
    };
  }
  if (prefer === "landscape") {
    return {
      params: { min_width: "1280", min_height: "720" },
      mode: "dim-filter",
      adapter: "dim-filter",
      prefer,
    };
  }
  // square — soft size floor; dim-filter prefers near-square
  return {
    params: { min_width: "480", min_height: "480" },
    mode: "dim-filter",
    adapter: "dim-filter",
    prefer: "square",
  };
}

/**
 * @param {Headers} headers
 * @param {"pexels" | "pixabay"} provider
 */
export function readRateHeaders(headers, provider) {
  if (provider === "pexels") {
    const remaining = Number(headers.get("X-Ratelimit-Remaining"));
    const limit = Number(headers.get("X-Ratelimit-Limit"));
    const reset = Number(headers.get("X-Ratelimit-Reset"));
    return {
      remaining: Number.isFinite(remaining) ? remaining : null,
      limit: Number.isFinite(limit) ? limit : null,
      reset: Number.isFinite(reset) ? reset : null,
    };
  }
  const remaining = Number(headers.get("X-RateLimit-Remaining"));
  const limit = Number(headers.get("X-RateLimit-Limit"));
  const reset = Number(headers.get("X-RateLimit-Reset"));
  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    limit: Number.isFinite(limit) ? limit : null,
    reset: Number.isFinite(reset) ? reset : null,
  };
}

function cacheKey(provider, query, orientation, videoType) {
  return `${provider}|${query}|${orientation || ""}|${videoType || ""}`;
}

function getCached(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    searchCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value) {
  searchCache.set(key, {
    expires: Date.now() + SEARCH_CACHE_TTL_MS,
    value,
  });
}

/** @param {"pexels" | "pixabay"} provider */
function getRateBucket(provider) {
  let s = rateState.get(provider);
  if (!s) {
    s = { lastAt: 0, backoffUntil: 0 };
    rateState.set(provider, s);
  }
  return s;
}

/**
 * @param {"pexels" | "pixabay"} provider
 * @param {{ remaining: number | null, reset: number | null }} rate
 * @param {boolean} is429
 */
export function noteRateLimit(provider, rate, is429 = false) {
  const bucket = getRateBucket(provider);
  const now = Date.now();
  if (
    is429 ||
    (rate.remaining !== null && rate.remaining <= PROVIDER_REMAINING_FLOOR)
  ) {
    const resetMs =
      rate.reset !== null && rate.reset > 0
        ? rate.reset < 1e12
          ? rate.reset * 1000
          : rate.reset
        : now + 60_000;
    bucket.backoffUntil = Math.max(bucket.backoffUntil, resetMs);
  }
}

/**
 * @param {"pexels" | "pixabay"} provider
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function awaitProviderGate(provider) {
  const bucket = getRateBucket(provider);
  const now = Date.now();
  if (bucket.backoffUntil > now) {
    return { ok: false, reason: "backoff" };
  }
  if (provider === "pixabay") {
    const skipPace =
      process.env.VITEST === "true" || process.env.NODE_ENV === "test";
    if (!skipPace) {
      const wait = PIXABAY_MIN_GAP_MS - (now - bucket.lastAt);
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  bucket.lastAt = Date.now();
  return { ok: true };
}

/**
 * @param {"pexels" | "pixabay"} provider
 * @returns {boolean}
 */
export function isProviderInBackoff(provider) {
  return getRateBucket(provider).backoffUntil > Date.now();
}

/**
 * @param {unknown} hit
 * @param {"portrait" | "landscape" | "square" | undefined} prefer
 */
function pixabayDims(hit) {
  const large = hit?.videos?.large;
  const medium = hit?.videos?.medium;
  const src = large?.url ? large : medium;
  return {
    width: Number(src?.width) || Number(hit?.videos?.medium?.width) || 0,
    height: Number(src?.height) || Number(hit?.videos?.medium?.height) || 0,
    url: typeof src?.url === "string" ? src.url : null,
  };
}

/**
 * Client-side orientation filter for Pixabay hits (videos API has no orientation).
 * @param {unknown[]} hits
 * @param {"portrait" | "landscape" | "square" | undefined} prefer
 */
export function filterPixabayByOrientation(hits, prefer) {
  const list = Array.isArray(hits) ? hits : [];
  if (!prefer) return list;
  return list.filter((hit) => {
    const { width: w, height: h } = pixabayDims(hit);
    if (!w || !h) return true;
    if (prefer === "portrait") return h >= w;
    if (prefer === "landscape") return w >= h;
    if (prefer === "square") return Math.abs(w - h) < Math.max(w, h) * 0.2;
    return true;
  });
}

/**
 * Normalize a provider hit to a uniform asset.
 * @param {unknown} hit
 * @param {"pexels" | "pixabay"} provider
 * @param {"portrait" | "landscape" | "square" | undefined} preferredOrientation
 * @param {"params" | "dim-filter"} [_mode]
 * @returns {{ url: string, imageUrl: string | null, provider: string, providerAssetId: string } | null}
 */
export function toAsset(hit, provider, preferredOrientation, _mode) {
  if (provider === "pexels") {
    const url = pickOptimalMp4(hit?.video_files, preferredOrientation);
    if (!url) return null;
    const id = hit?.id != null ? String(hit.id) : url;
    return {
      url,
      imageUrl: pickPreviewImage(hit),
      provider: "pexels",
      providerAssetId: id,
    };
  }

  const dims = pixabayDims(hit);
  if (!dims.url) return null;
  // Prefer medium (usually 1280/1920) over large 4K for encode cost.
  const medium = hit?.videos?.medium;
  const small = hit?.videos?.small;
  const large = hit?.videos?.large;
  const url =
    (typeof medium?.url === "string" && medium.url) ||
    (typeof large?.url === "string" && large.url) ||
    (typeof small?.url === "string" && small.url) ||
    dims.url;

  const pictureId = hit?.picture_id != null ? String(hit.picture_id) : null;
  const imageUrl = pictureId
    ? `https://i.vimeocdn.com/video/${pictureId}_295x166.jpg`
    : typeof large?.thumbnail === "string"
      ? large.thumbnail
      : typeof hit?.userImageURL === "string"
        ? hit.userImageURL
        : null;

  const id = hit?.id != null ? String(hit.id) : url;
  return {
    url,
    imageUrl,
    provider: "pixabay",
    providerAssetId: id,
  };
}

function pixabayKeyConfigured() {
  const key = process.env.PIXABAY_API_KEY;
  return Boolean(key && key !== "your_pixabay_key_here" && key.trim());
}

/**
 * @returns {{ available: boolean, reason?: string }}
 */
export function pixabayAvailability() {
  if (!pixabayKeyConfigured()) {
    return { available: false, reason: "missing_key" };
  }
  if (isProviderInBackoff("pixabay")) {
    return { available: false, reason: "backoff" };
  }
  return { available: true };
}

/**
 * Search one provider. Never throws on missing Pixabay key (D12).
 *
 * @param {string} query
 * @param {{ orientation?: string, visualStyle?: string | null, videoType?: string, forceNetwork?: boolean }} [opts]
 * @param {"pexels" | "pixabay"} provider
 * @returns {Promise<{ results: { url: string, imageUrl: string | null, provider: string, providerAssetId: string }[], rate: { remaining: number | null, reset: number | null, limit: number | null }, provider_unavailable?: boolean, cacheHit?: boolean, rateLimited?: boolean }>}
 */
export async function searchCandidates(query, opts = {}, provider = "pexels") {
  const q = String(query || "").trim();
  if (!q) {
    return {
      results: [],
      rate: { remaining: null, reset: null, limit: null },
    };
  }

  const orientation = opts.orientation;
  const videoType =
    opts.videoType ||
    (provider === "pixabay" && isStrictStyleTier(opts.visualStyle)
      ? "animation"
      : undefined);

  if (provider === "pixabay" && !pixabayKeyConfigured()) {
    console.log(
      JSON.stringify({
        event: "provider_unavailable",
        provider: "pixabay",
        reason: "missing_key",
      })
    );
    return {
      results: [],
      rate: { remaining: null, reset: null, limit: null },
      provider_unavailable: true,
      unavailable: true,
    };
  }

  const key = cacheKey(provider, q.toLowerCase(), orientation, videoType);
  if (!opts.forceNetwork) {
    const cached = getCached(key);
    if (cached) {
      console.log(
        JSON.stringify({
          event: "provider_cache_hit",
          provider,
          query: q.slice(0, 80),
        })
      );
      return { ...cached, cacheHit: true };
    }
  }

  const mapped = toProviderParams(orientation, provider);
  console.log(
    JSON.stringify({
      event: "orientation_adapter",
      provider,
      adapter: mapped.adapter,
      prefer: mapped.prefer,
    })
  );

  const gate = await awaitProviderGate(provider);
  if (!gate.ok) {
    console.log(
      JSON.stringify({
        event: "rate_limit_swap",
        provider,
        reason: gate.reason,
      })
    );
    return {
      results: [],
      rate: { remaining: null, reset: null, limit: null },
      rateLimited: true,
    };
  }

  if (provider === "pexels") {
    const apiKey = process.env.PEXELS_API_KEY;
    const params = new URLSearchParams({
      query: q,
      per_page: "8",
      ...mapped.params,
    });
    const response = await fetch(`${PEXELS_VIDEO_SEARCH_URL}?${params}`, {
      method: "GET",
      headers: { Authorization: apiKey },
      cache: "no-store",
    });
    const rate = readRateHeaders(response.headers, "pexels");
    if (response.status === 429) {
      noteRateLimit("pexels", rate, true);
      console.log(
        JSON.stringify({ event: "rate_limit_swap", provider: "pexels", status: 429 })
      );
      return { results: [], rate, rateLimited: true };
    }
    if (!response.ok) {
      const detail = await response.text();
      console.error("Pexels search error:", q, detail.slice(0, 200));
      return { results: [], rate };
    }
    noteRateLimit("pexels", rate, false);
    const data = await response.json();
    const videos = Array.isArray(data?.videos) ? data.videos : [];
    const results = [];
    for (const video of videos) {
      const asset = toAsset(video, "pexels", mapped.prefer);
      if (asset) results.push(asset);
    }
    const payload = { results, rate };
    setCached(key, payload);
    return payload;
  }

  // Pixabay
  const apiKey = process.env.PIXABAY_API_KEY;
  const params = new URLSearchParams({
    key: apiKey,
    q,
    per_page: "8",
    ...mapped.params,
  });
  if (videoType) params.set("video_type", videoType);

  const response = await fetch(`${PIXABAY_VIDEO_SEARCH_URL}?${params}`, {
    method: "GET",
    cache: "no-store",
  });
  const rate = readRateHeaders(response.headers, "pixabay");
  if (response.status === 429) {
    noteRateLimit("pixabay", rate, true);
    console.log(
      JSON.stringify({ event: "rate_limit_swap", provider: "pixabay", status: 429 })
    );
    return { results: [], rate, rateLimited: true };
  }
  if (!response.ok) {
    const detail = await response.text();
    console.error("Pixabay search error:", q, detail.slice(0, 200));
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      console.log(
        JSON.stringify({
          event: "provider_unavailable",
          provider: "pixabay",
          status: response.status,
        })
      );
      return { results: [], rate, provider_unavailable: true, unavailable: true };
    }
    return { results: [], rate };
  }
  noteRateLimit("pixabay", rate, false);
  const data = await response.json();
  let hits = Array.isArray(data?.hits) ? data.hits : [];
  if (mapped.adapter === "dim-filter") {
    hits = filterPixabayByOrientation(hits, mapped.prefer);
  }
  const results = [];
  for (const hit of hits) {
    const asset = toAsset(hit, "pixabay", mapped.prefer);
    if (asset) results.push(asset);
  }
  const payload = { results, rate };
  setCached(key, payload);
  return payload;
}

/** Test helper: clear caches / rate state. */
export function clearProviderSearchCache() {
  searchCache.clear();
  rateState.clear();
}

/** @deprecated alias */
export function _resetProviderStateForTests() {
  clearProviderSearchCache();
}
