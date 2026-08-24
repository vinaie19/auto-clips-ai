import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

const DOWNLOAD_TIMEOUT_MS = Number(process.env.CLIP_DOWNLOAD_TIMEOUT_MS || 180_000);

/**
 * Download remote clips into workDir as clip-0.mp4 …
 * @param {string[]} urls
 * @param {string} workDir
 * @returns {Promise<string[]>} local paths
 */
export async function downloadClips(urls, workDir) {
  const paths = [];
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    const dest = join(workDir, `clip-${i}.mp4`);
    console.log(
      JSON.stringify({
        event: "download_clip_start",
        index: i,
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
        const err = new Error(`Failed to download clip ${i}: HTTP ${response.status}`);
        err.status = response.status >= 500 ? response.status : 502;
        throw err;
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
      console.log(JSON.stringify({ event: "download_clip_done", index: i }));
      paths.push(dest);
    } catch (err) {
      if (err?.name === "AbortError") {
        const timeoutErr = new Error(
          `Clip download timed out after ${DOWNLOAD_TIMEOUT_MS}ms (index ${i})`
        );
        timeoutErr.status = 504;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return paths;
}
