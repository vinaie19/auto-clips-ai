import { readFile } from "node:fs/promises";
import { File } from "node:buffer";
import { computeCaptionTimings } from "./captions.js";

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

function normalizeWord(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^\w'’-]/g, "")
    .trim();
}

/**
 * Whisper word timestamps for an audio file (TTS mp3).
 * @param {string} audioPath
 * @returns {Promise<{ word: string, start: number, end: number }[]>}
 */
export async function transcribeWords(audioPath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.status = 500;
    throw err;
  }

  const buf = await readFile(audioPath);
  const form = new FormData();
  form.append("file", new File([buf], "audio.mp3", { type: "audio/mpeg" }));
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const response = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text();
    const err = new Error(`Whisper align failed: ${detail.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const payload = await response.json();
  const words = Array.isArray(payload?.words) ? payload.words : [];
  return words
    .map((w) => ({
      word: normalizeWord(w.word),
      start: Number(w.start),
      end: Number(w.end),
    }))
    .filter(
      (w) =>
        w.word &&
        Number.isFinite(w.start) &&
        Number.isFinite(w.end) &&
        w.end >= w.start
    );
}

/**
 * Map punchy caption blocks onto Whisper word timings.
 * Falls back to proportional timing when alignment is too weak.
 * @param {string[]} blocks
 * @param {{ word: string, start: number, end: number }[]} words
 * @param {number} totalDuration
 */
export function timingsFromWordAlignment(blocks, words, totalDuration) {
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  const duration = Math.max(0.5, Number(totalDuration) || 0);
  if (list.length === 0) return [];

  const aligned = Array.isArray(words) ? words : [];
  if (aligned.length === 0) {
    return computeCaptionTimings(list, duration);
  }

  let cursor = 0;
  /** @type {{ start: number, end: number, text: string }[]} */
  const out = [];
  let matchedBlocks = 0;

  for (let bi = 0; bi < list.length; bi += 1) {
    const text = String(list[bi]);
    const want = text
      .split(/\s+/)
      .map(normalizeWord)
      .filter(Boolean);

    if (want.length === 0) continue;

    let start = null;
    let end = null;
    let wi = 0;

    while (cursor < aligned.length && wi < want.length) {
      const got = aligned[cursor];
      if (got.word === want[wi] || got.word.includes(want[wi]) || want[wi].includes(got.word)) {
        if (start == null) start = got.start;
        end = got.end;
        wi += 1;
        cursor += 1;
      } else if (wi === 0) {
        // Skip filler / mismatch at block boundary.
        cursor += 1;
      } else {
        break;
      }
    }

    if (start == null || end == null || wi < Math.ceil(want.length * 0.5)) {
      // Weak match — fall back for remaining span.
      const remainingBlocks = list.slice(bi);
      const remainingStart = out.length > 0 ? out[out.length - 1].end : 0;
      const remainingDur = Math.max(0.5, duration - remainingStart);
      const fallback = computeCaptionTimings(remainingBlocks, remainingDur).map(
        (t) => ({
          ...t,
          start: Number((t.start + remainingStart).toFixed(4)),
          end: Number((t.end + remainingStart).toFixed(4)),
        })
      );
      out.push(...fallback);
      return out;
    }

    matchedBlocks += 1;
    const prevEnd = out.length > 0 ? out[out.length - 1].end : 0;
    const safeStart = Math.max(prevEnd, Number(start.toFixed(4)));
    let safeEnd = Math.max(safeStart + 0.12, Number(end.toFixed(4)));
    if (bi === list.length - 1) {
      safeEnd = Math.max(safeEnd, duration);
    }
    out.push({ start: safeStart, end: Math.min(duration, safeEnd), text });
  }

  if (matchedBlocks < Math.ceil(list.length * 0.4)) {
    return computeCaptionTimings(list, duration);
  }

  if (out.length > 0) {
    out[out.length - 1].end = duration;
  }
  return out;
}

/**
 * Build caption timings from audio when possible; otherwise proportional.
 */
export async function resolveCaptionTimings(blocks, audioPath, totalDuration) {
  try {
    const words = await transcribeWords(audioPath);
    return timingsFromWordAlignment(blocks, words, totalDuration);
  } catch (err) {
    console.warn("caption align fallback:", err?.message || err);
    return computeCaptionTimings(blocks, totalDuration);
  }
}
