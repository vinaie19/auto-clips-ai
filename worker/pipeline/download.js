import { createWriteStream } from "node:fs";
import { copyFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

const DOWNLOAD_TIMEOUT_MS = Number(process.env.CLIP_DOWNLOAD_TIMEOUT_MS || 180_000);
/** Bounded parallel fetches — keeps quality identical, cuts wall-clock. */
const DOWNLOAD_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.CLIP_DOWNLOAD_CONCURRENCY || 3) || 3)
);

/**
 * Download a single remote clip to dest.
 * @param {string} url
 * @param {string} dest
 * @param {number} index
 */
async function downloadOne(url, dest, index) {
  console.log(
    JSON.stringify({
      event: "download_clip_start",
      index,
      timeout_ms: DOWNLOAD_TIMEOUT_MS,
    })
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const err = new Error(`Failed to download clip ${index}: HTTP ${response.status}`);
      err.status = response.status >= 500 ? response.status : 502;
      throw err;
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
    console.log(JSON.stringify({ event: "download_clip_done", index }));
    return dest;
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeoutErr = new Error(
        `Clip download timed out after ${DOWNLOAD_TIMEOUT_MS}ms (index ${index})`
      );
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download remote clips into workDir as clip-0.mp4 …
 * Uses a small concurrency pool (default 3). When assetIds / visualBeats are
 * provided, identical providerAssetId values reuse one download (fair-use).
 *
 * @param {string[]} urls
 * @param {string} workDir
 * @param {{ assetIds?: (string | null | undefined)[] } | { providerAssetId?: string }[]} [optsOrBeats]
 * @returns {Promise<string[]>} local paths (ordered by input index)
 */
export async function downloadClips(urls, workDir, optsOrBeats = {}) {
  const paths = new Array(urls.length);
  let assetIds = [];
  if (Array.isArray(optsOrBeats)) {
    assetIds = optsOrBeats.map((b) =>
      b && typeof b.providerAssetId === "string" ? b.providerAssetId : null
    );
  } else if (optsOrBeats && typeof optsOrBeats === "object") {
    assetIds = Array.isArray(optsOrBeats.assetIds) ? optsOrBeats.assetIds : [];
  }
  /** @type {Map<string, Promise<string>>} */
  const mediaCache = new Map();
  let nextIndex = 0;

  async function resolveIndex(i) {
    const dest = join(workDir, `clip-${i}.mp4`);
    const assetId =
      typeof assetIds[i] === "string" && assetIds[i].trim()
        ? assetIds[i].trim()
        : null;
    const cacheKey = assetId || urls[i];

    if (mediaCache.has(cacheKey)) {
      const existing = await mediaCache.get(cacheKey);
      if (existing !== dest) {
        await copyFile(existing, dest);
        console.log(
          JSON.stringify({
            event: "provider_media_cache_hit",
            index: i,
            asset_id: assetId,
          })
        );
      }
      paths[i] = dest;
      return;
    }

    const pending = downloadOne(urls[i], dest, i);
    mediaCache.set(cacheKey, pending);
    paths[i] = await pending;
  }

  async function worker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= urls.length) return;
      await resolveIndex(i);
    }
  }

  const pool = Math.min(DOWNLOAD_CONCURRENCY, urls.length || 1);
  console.log(
    JSON.stringify({
      event: "download_clips_start",
      count: urls.length,
      concurrency: pool,
    })
  );
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return paths;
}
