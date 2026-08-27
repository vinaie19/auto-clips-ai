/**
 * B-roll: one clip per spoken script line (line-bound beats).
 * Routes Pexels + Pixabay by visual style; gpt-4o-mini vision verifies stills.
 */

import { verifyClipAgainstLine } from "./clip-verify.js";
import { isStrictStyleTier } from "./video-taxonomy.js";
import {
  pickOptimalMp4,
  pickPreviewImage,
  searchCandidates,
  getPexelsApiKey,
} from "./providers.js";

export { pickOptimalMp4, pickPreviewImage };
export {
  SEARCH_CACHE_TTL_MS,
  clearProviderSearchCache,
  toProviderParams,
  toAsset,
  createMediaCache,
  createRenderMediaCache,
  _resetProviderStateForTests,
  searchCandidates,
  getPexelsApiKey,
} from "./providers.js";

export const MAX_VISUAL_BEATS = 15;
export const MIN_VISUAL_BEATS = 4;
/** Provider hits to try per search query before a betterQuery round. */
export const MAX_VERIFY_CANDIDATES = 6;
/** Max vision API calls per beat (relevance). */
export const MAX_VISION_ATTEMPTS = 3;
/** Max distinct search queries per beat (initial + betterQuery rounds). */
export const MAX_QUERY_ROUNDS = 3;
/** Extra unused clips when vision path finds nothing. */
export const MAX_FALLBACK_CANDIDATES = 8;
/** Strict-tier style-mismatch retries before betterQuery (D6). */
export const MAX_STYLE_RETRIES = 2;
/** Hard cap on vision calls across the whole render (F12). */
export const MAX_VISION_CALLS_PER_RENDER = 30;
/**
 * Minimum relevance score to keep a rejected clip. Below this we prefer the
 * motif bank over shipping unrelated footage (Ganesha / snow / etc.).
 */
export const KEEP_BEST_MIN_SCORE = 0.35;
/** How many motif-bank clips to pre-fetch for theme continuity. */
export const MOTIF_BANK_SIZE = 16;

/**
 * Style-aware provider order (D5). Animated tier → Pixabay first.
 * @param {string | null | undefined} visualStyle
 * @returns {("pexels" | "pixabay")[]}
 */
export function providerOrderForStyle(visualStyle) {
  if (isStrictStyleTier(visualStyle)) {
    return ["pixabay", "pexels"];
  }
  return ["pexels", "pixabay"];
}

/**
 * True when a string looks like a stock search phrase, not a narration fragment.
 * Blocks retries like "So, next time you see" / "You might wonder about their".
 * @param {string} q
 */
export function isPlausibleStockQuery(q) {
  const s = String(q || "").trim();
  if (s.length < 4) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  if (
    /^(so|now|why|because|you|they|we|this|that|their|there|here|let'?s|next|then|when|while|and|but|or|if|as|just|maybe|might)\b/i.test(
      s
    )
  ) {
    return false;
  }
  // Reject sentence-like tails (punctuation / trailing conjunctions)
  if (/[.!?]$/.test(s) || /,$/.test(s)) return false;
  return true;
}

function orientationTryOrder(preferredOrientation) {
  const primary =
    preferredOrientation === "square"
      ? undefined
      : preferredOrientation === "landscape"
        ? "landscape"
        : preferredOrientation === "portrait"
          ? "portrait"
          : "portrait";

  return [
    primary,
    primary === "portrait" ? "landscape" : "portrait",
    undefined,
  ].filter((v, i, arr) => arr.indexOf(v) === i);
}

/**
 * Collect unused mp4 + preview candidates (does not mutate usedUrls).
 * @returns {Promise<{ url: string, imageUrl: string | null, provider: string, providerAssetId: string }[]>}
 */
async function collectClipCandidates(
  query,
  usedUrls,
  preferredOrientation,
  limit = MAX_VERIFY_CANDIDATES,
  { visualStyle } = {}
) {
  const q = String(query || "").trim();
  if (!q) return [];

  /** @type {{ url: string, imageUrl: string | null, provider: string, providerAssetId: string }[]} */
  const out = [];
  const seen = new Set();
  const order = providerOrderForStyle(visualStyle);
  const wantAnimation = isStrictStyleTier(visualStyle);

  for (const provider of order) {
    if (out.length >= limit) break;
    for (const orientation of orientationTryOrder(preferredOrientation)) {
      if (out.length >= limit) break;
      const result = await searchCandidates(
        q,
        {
          orientation,
          videoType:
            provider === "pixabay" && wantAnimation ? "animation" : undefined,
          visualStyle,
        },
        provider
      );

      if (result.provider_unavailable || result.rateLimited) {
        break;
      }

      for (const asset of result.results || []) {
        if (out.length >= limit) break;
        if (!asset?.url || usedUrls.has(asset.url) || seen.has(asset.url)) {
          continue;
        }
        seen.add(asset.url);
        out.push(asset);
      }
    }
  }

  return out;
}

/**
 * Pick clip and vision-verify vs spoken line (+ optional style axis).
 * @returns {Promise<{ url: string, query: string, verified: boolean, retried: boolean, provider?: string, providerAssetId?: string, styleMatch?: boolean } | null>}
 */
export async function resolveVerifiedClip({
  query,
  line,
  usedUrls,
  preferredOrientation,
  visualStyle = null,
  visionBudget = null,
}) {
  const initialQuery = String(query || "").trim();
  if (!initialQuery) return null;

  const spoken = String(line || "").trim() || initialQuery;
  const triedQueries = new Set();
  const triedUrls = new Set();
  let searchQuery = initialQuery;
  let visionAttempts = 0;
  let queryRounds = 0;
  let styleRetries = 0;
  let lastBetterQuery = null;
  const strictTier = isStrictStyleTier(visualStyle);

  /** @type {{ url: string, query: string, score: number, styleScore?: number, provider?: string, providerAssetId?: string, styleMatch?: boolean } | null} */
  let bestRejected = null;

  const nextStockQuery = () => {
    if (
      lastBetterQuery &&
      isPlausibleStockQuery(lastBetterQuery) &&
      !triedQueries.has(lastBetterQuery.toLowerCase())
    ) {
      return lastBetterQuery.trim();
    }
    return null;
  };

  const budgetExhausted = () =>
    visionBudget &&
    typeof visionBudget.calls === "number" &&
    visionBudget.calls >= MAX_VISION_CALLS_PER_RENDER;

  while (
    visionAttempts < MAX_VISION_ATTEMPTS &&
    queryRounds < MAX_QUERY_ROUNDS &&
    !budgetExhausted()
  ) {
    const qKey = searchQuery.toLowerCase();
    if (triedQueries.has(qKey)) break;
    triedQueries.add(qKey);
    queryRounds += 1;

    const blocked = new Set([...usedUrls, ...triedUrls]);
    const candidates = await collectClipCandidates(
      searchQuery,
      blocked,
      preferredOrientation,
      MAX_VERIFY_CANDIDATES,
      { visualStyle }
    );

    if (candidates.length === 0) {
      const next = nextStockQuery();
      if (!next) break;
      searchQuery = next;
      continue;
    }

    for (const hit of candidates) {
      if (visionAttempts >= MAX_VISION_ATTEMPTS || budgetExhausted()) break;
      if (triedUrls.has(hit.url) || usedUrls.has(hit.url)) continue;

      if (!hit.imageUrl) {
        usedUrls.add(hit.url);
        return {
          url: hit.url,
          query: searchQuery,
          verified: false,
          retried: queryRounds > 1 || visionAttempts > 0,
          provider: hit.provider,
          providerAssetId: hit.providerAssetId,
          styleMatch: false,
        };
      }

      visionAttempts += 1;
      if (visionBudget) visionBudget.calls += 1;
      triedUrls.add(hit.url);

      const verdict = await verifyClipAgainstLine({
        line: spoken,
        query: searchQuery,
        imageUrl: hit.imageUrl,
        style: strictTier ? visualStyle : null,
      });

      if (verdict.betterQuery && isPlausibleStockQuery(verdict.betterQuery)) {
        lastBetterQuery = verdict.betterQuery.trim();
      }

      const styleOk = !strictTier || verdict.styleMatch === true;
      if (verdict.match && styleOk) {
        usedUrls.add(hit.url);
        console.log(
          JSON.stringify({
            event: "clip_verify_match",
            line: spoken.slice(0, 80),
            query: searchQuery,
            score: verdict.score,
            style_score: verdict.styleScore,
            attempts: visionAttempts,
            rounds: queryRounds,
            provider: hit.provider,
          })
        );
        return {
          url: hit.url,
          query: searchQuery,
          verified: true,
          retried: visionAttempts > 1 || queryRounds > 1,
          provider: hit.provider,
          providerAssetId: hit.providerAssetId,
          styleMatch: Boolean(verdict.styleMatch),
        };
      }

      if (verdict.match && strictTier && !styleOk) {
        styleRetries += 1;
        console.log(
          JSON.stringify({
            event: "clip_verify_style_reject",
            line: spoken.slice(0, 80),
            query: searchQuery,
            score: verdict.score,
            style_score: verdict.styleScore,
            style_retries: styleRetries,
            provider: hit.provider,
          })
        );
        if (
          !bestRejected ||
          (verdict.styleScore ?? 0) >= (bestRejected.styleScore ?? -1) ||
          verdict.score >= bestRejected.score
        ) {
          bestRejected = {
            url: hit.url,
            query: searchQuery,
            score: verdict.score,
            styleScore: verdict.styleScore ?? 0,
            provider: hit.provider,
            providerAssetId: hit.providerAssetId,
            styleMatch: false,
          };
        }
        if (styleRetries < MAX_STYLE_RETRIES) {
          continue;
        }
        break;
      }

      if (!bestRejected || verdict.score >= bestRejected.score) {
        bestRejected = {
          url: hit.url,
          query: searchQuery,
          score: verdict.score,
          provider: hit.provider,
          providerAssetId: hit.providerAssetId,
          styleMatch: Boolean(verdict.styleMatch),
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

    const nextQuery = nextStockQuery();
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

  // Only keep a reject when relevance is plausible — otherwise motif bank fills.
  if (
    bestRejected &&
    !usedUrls.has(bestRejected.url) &&
    bestRejected.score >= KEEP_BEST_MIN_SCORE
  ) {
    usedUrls.add(bestRejected.url);
    console.log(
      JSON.stringify({
        event:
          strictTier && bestRejected.styleMatch === false
            ? "clip_verify_keep_best_offstyle"
            : "clip_verify_keep_best",
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
      provider: bestRejected.provider,
      providerAssetId: bestRejected.providerAssetId,
      styleMatch: Boolean(bestRejected.styleMatch),
    };
  }

  if (bestRejected && bestRejected.score < KEEP_BEST_MIN_SCORE) {
    console.log(
      JSON.stringify({
        event: "clip_verify_discard_low_score",
        line: spoken.slice(0, 80),
        query: bestRejected.query,
        score: bestRejected.score,
        min: KEEP_BEST_MIN_SCORE,
      })
    );
  }

  return null;
}

/**
 * First unused mp4 for a query (no vision).
 */
export async function pickUnusedClip({
  query,
  usedUrls,
  preferredOrientation,
  visualStyle = null,
  limit = MAX_FALLBACK_CANDIDATES,
}) {
  const q = String(query || "").trim();
  if (!q) return null;
  const candidates = await collectClipCandidates(
    q,
    usedUrls,
    preferredOrientation,
    limit,
    { visualStyle }
  );
  const hit = candidates.find((c) => c.url && !usedUrls.has(c.url));
  if (!hit) return null;
  usedUrls.add(hit.url);
  return {
    url: hit.url,
    query: q,
    verified: false,
    retried: true,
    provider: hit.provider,
    providerAssetId: hit.providerAssetId,
    styleMatch: false,
  };
}

/**
 * Bounded parallel map.
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapPool(items, concurrency, fn) {
  const n = items.length;
  const out = new Array(n);
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, n || 1));

  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= n) return;
      out[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

function brollConcurrency() {
  return Math.max(
    1,
    Math.min(8, Number(process.env.BROLL_CONCURRENCY || 3) || 3)
  );
}

async function resolveBeatDraft(
  query,
  line,
  motif,
  preferredOrientation,
  visualStyle,
  visionBudget
) {
  const privateUsed = new Set();

  let preferred = await resolveVerifiedClip({
    query,
    line,
    usedUrls: privateUsed,
    preferredOrientation,
    visualStyle,
    visionBudget,
  });

  // Theme retry: search motif with style routing still on (may get on-style theme clips)
  if (!preferred?.url && motif && isPlausibleStockQuery(motif)) {
    preferred = await resolveVerifiedClip({
      query: motif,
      line: line || motif,
      usedUrls: privateUsed,
      preferredOrientation,
      visualStyle,
      visionBudget,
    });
  }

  // Subject-over-style: motif via Pexels-first (null style) so theme holds when animation fails
  if (!preferred?.url && motif && isPlausibleStockQuery(motif)) {
    preferred = await resolveVerifiedClip({
      query: motif,
      line: line || motif,
      usedUrls: privateUsed,
      preferredOrientation,
      visualStyle: null,
      visionBudget,
    });
    if (preferred?.url) {
      preferred = { ...preferred, styleMatch: false, retried: true };
    }
  }

  /** @type {{ url: string, provider?: string, providerAssetId?: string, query?: string }[]} */
  const alternates = [];
  const seen = new Set(preferred?.url ? [preferred.url] : []);
  // Line-query alternates only — motif continuity is the shared bank, not per-beat dupes
  if (query && isPlausibleStockQuery(query)) {
    const hits = await collectClipCandidates(
      query,
      new Set(),
      preferredOrientation,
      MAX_FALLBACK_CANDIDATES,
      { visualStyle: null }
    );
    for (const hit of hits) {
      if (!hit.url || seen.has(hit.url)) continue;
      seen.add(hit.url);
      alternates.push({ ...hit, query });
      if (alternates.length >= MAX_FALLBACK_CANDIDATES) break;
    }
  }

  return { preferred, alternates };
}

/**
 * Pre-fetch a shared theme bank (Pexels-first) so failed beats stay on-motif.
 * @param {string | null} motif
 * @param {string} preferredOrientation
 * @param {number} need
 */
async function buildMotifBank(motif, preferredOrientation, need) {
  const q = String(motif || "").trim();
  if (!q || !isPlausibleStockQuery(q)) return [];

  const limit = Math.min(
    MOTIF_BANK_SIZE,
    Math.max(need + 4, MIN_VISUAL_BEATS + 4)
  );
  const hits = await collectClipCandidates(
    q,
    new Set(),
    preferredOrientation,
    limit,
    { visualStyle: null }
  );

  // Shorten motif if sparse (e.g. "elephants and their behaviors" → "elephants")
  if (hits.length < MIN_VISUAL_BEATS) {
    const short = q.split(/\s+/).slice(0, 2).join(" ");
    if (short && short !== q) {
      const more = await collectClipCandidates(
        short,
        new Set(hits.map((h) => h.url)),
        preferredOrientation,
        limit,
        { visualStyle: null }
      );
      const seen = new Set(hits.map((h) => h.url));
      for (const h of more) {
        if (!h.url || seen.has(h.url)) continue;
        seen.add(h.url);
        hits.push(h);
        if (hits.length >= limit) break;
      }
    }
  }

  console.log(
    JSON.stringify({
      event: "motif_bank_ready",
      motif: q.slice(0, 80),
      clips: hits.length,
    })
  );
  return hits;
}

/**
 * Claim next unused clip from the motif bank.
 * @param {{ url: string, provider?: string, providerAssetId?: string }[]} bank
 * @param {Set<string>} usedUrls
 * @param {string} motif
 */
function claimFromMotifBank(bank, usedUrls, motif) {
  const hit = (bank || []).find((c) => c?.url && !usedUrls.has(c.url));
  if (!hit) return null;
  usedUrls.add(hit.url);
  return {
    url: hit.url,
    query: motif || "motif",
    verified: false,
    retried: true,
    provider: hit.provider || "pexels",
    providerAssetId: hit.providerAssetId || hit.url,
    styleMatch: false,
    fromMotifBank: true,
  };
}

/**
 * Map line-bound visual beat queries → stock URLs (ordered).
 *
 * @param {string[]} queries
 * @param {{ weights?: number[], lines?: string[], motif?: string, orientation?: string, visualStyle?: string | null }} [opts]
 */
export async function fetchBrollForQueries(queries, opts = {}) {
  if (!getPexelsApiKey()) {
    throw new Error("PEXELS_API_KEY is not configured on the worker.");
  }

  const weights = Array.isArray(opts.weights) ? opts.weights : [];
  const lines = Array.isArray(opts.lines) ? opts.lines : [];
  const motif = typeof opts.motif === "string" ? opts.motif.trim() : null;
  const visualStyle =
    typeof opts.visualStyle === "string" && opts.visualStyle.trim()
      ? opts.visualStyle.trim().toLowerCase()
      : null;
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

  const concurrency = brollConcurrency();
  /** @type {{ calls: number }} */
  const visionBudget = { calls: 0 };

  console.log(
    JSON.stringify({
      event: "broll_fetch_start",
      count: cleaned.length,
      concurrency,
      visual_style: visualStyle,
      motif: motif ? motif.slice(0, 80) : null,
    })
  );

  const motifBank = await buildMotifBank(
    motif,
    preferredOrientation,
    cleaned.length
  );

  const drafts = await mapPool(cleaned, concurrency, async (query, i) => {
    const line =
      typeof lines[i] === "string" && lines[i].trim() ? lines[i].trim() : null;
    const draft = await resolveBeatDraft(
      query,
      line,
      motif,
      preferredOrientation,
      visualStyle,
      visionBudget
    );
    return { index: i, query, line, ...draft };
  });

  const usedUrls = new Set();
  const visualBeats = [];
  let motifBankClaims = 0;

  for (const draft of drafts) {
    const { index: i, query, line, preferred, alternates } = draft;
    let resolved = null;

    if (preferred?.url && !usedUrls.has(preferred.url)) {
      usedUrls.add(preferred.url);
      resolved = preferred;
    } else {
      const alt = (alternates || []).find(
        (a) => a?.url && !usedUrls.has(a.url)
      );
      if (alt) {
        usedUrls.add(alt.url);
        resolved = {
          url: alt.url,
          query: alt.query || query,
          verified: false,
          retried: true,
          provider: alt.provider,
          providerAssetId: alt.providerAssetId,
          styleMatch: false,
        };
        console.log(
          JSON.stringify({
            event: "clip_unique_alternate",
            index: i,
            query: resolved.query,
            line: (line || "").slice(0, 80),
          })
        );
      }
    }

    // Theme continuity: pull from shared motif bank before more random searches
    if (!resolved?.url && motifBank.length > 0) {
      resolved = claimFromMotifBank(motifBank, usedUrls, motif);
      if (resolved?.url) {
        motifBankClaims += 1;
        console.log(
          JSON.stringify({
            event: "clip_motif_bank",
            index: i,
            query: motif,
            line: (line || "").slice(0, 80),
          })
        );
      }
    }

    if (!resolved?.url && motif && isPlausibleStockQuery(motif)) {
      resolved = await pickUnusedClip({
        query: motif,
        usedUrls,
        preferredOrientation,
        visualStyle: null,
      });
      if (resolved?.url) {
        console.log(
          JSON.stringify({
            event: "clip_motif_fallback",
            index: i,
            query: motif,
            line: (line || "").slice(0, 80),
          })
        );
      }
    }

    if (!resolved?.url && isPlausibleStockQuery(query)) {
      resolved = await pickUnusedClip({
        query,
        usedUrls,
        preferredOrientation,
        visualStyle: null,
      });
      if (resolved?.url) {
        console.log(
          JSON.stringify({
            event: "clip_unique_fallback",
            index: i,
            query,
            line: (line || "").slice(0, 80),
          })
        );
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
        provider: resolved.provider || "pexels",
        providerAssetId: resolved.providerAssetId || resolved.url,
        styleMatch: resolved.styleMatch === true,
        fromMotifBank: Boolean(resolved.fromMotifBank),
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
    throw new Error("Failed to fetch any related B-roll clips.");
  }

  if (visualBeats.length < Math.min(MIN_VISUAL_BEATS, cleaned.length)) {
    const err = new Error(
      `Only found ${visualBeats.length} unique B-roll clips (need ${MIN_VISUAL_BEATS}).`
    );
    err.status = 502;
    throw err;
  }

  const strictTier = isStrictStyleTier(visualStyle);
  const styleBeats = strictTier
    ? visualBeats.filter((b) => b.styleMatch === true).length
    : 0;
  const styleAcceptanceRate = strictTier
    ? visualBeats.length > 0
      ? styleBeats / visualBeats.length
      : null
    : null;
  const styleDegraded = strictTier && styleBeats < MIN_VISUAL_BEATS;

  const uniqueCount = new Set(visualBeats.map((b) => b.url)).size;
  console.log(
    JSON.stringify({
      event: "broll_unique_summary",
      beats: visualBeats.length,
      unique_urls: uniqueCount,
      queries: cleaned.length,
      concurrency,
      style_beats: styleBeats,
      style_acceptance_rate: styleAcceptanceRate,
      vision_calls: visionBudget.calls,
      style_degraded: styleDegraded,
      motif_bank_size: motifBank.length,
      motif_bank_claims: motifBankClaims,
    })
  );

  return {
    pexelsVideoUrls: visualBeats.map((b) => b.url),
    visualBeats,
    motif,
    styleAcceptanceRate,
    styleDegraded,
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
