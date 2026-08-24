import { readFile } from "node:fs/promises";
import { File } from "node:buffer";
import { computeCaptionTimings } from "./captions.js";

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

/**
 * Normalize for Whisper ↔ script matching (curly quotes, accents, punct).
 * @param {unknown} raw
 */
export function normalizeWord(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u201a\u2032`]/g, "'")
    .replace(/[\u201c\u201d\u201e]/g, "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\w'-]/g, "")
    .replace(/^'+|'+$/g, "")
    .trim();
}

function wordsLooselyEqual(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) {
    return true;
  }
  return false;
}

/**
 * Scale Whisper timings from raw-TTS timebase into fitted/mux timebase.
 * @param {{ word: string, start: number, end: number }[]} words
 * @param {number} scale fittedDuration / rawDuration
 */
export function scaleWordTimings(words, scale) {
  const s = Number(scale);
  if (!Array.isArray(words) || words.length === 0) return [];
  if (!Number.isFinite(s) || Math.abs(s - 1) < 0.001) return words;
  return words.map((w) => ({
    word: w.word,
    start: Number((w.start * s).toFixed(4)),
    end: Number((w.end * s).toFixed(4)),
  }));
}

/**
 * Whisper word timestamps for an audio file (prefer raw TTS, not atempo).
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
 * Match one caption block against Whisper words starting at cursor.
 * Allows a few filler skips mid-phrase so one mismatch does not kill alignment.
 * If the block start is not found, cursor is left unchanged so later blocks can sync.
 */
function matchBlockWords(want, aligned, startCursor) {
  if (!want.length) {
    return { start: null, end: null, matched: 0, cursor: startCursor };
  }

  // Locate first script word without burning later phrases.
  let startIdx = -1;
  for (let i = startCursor; i < aligned.length; i += 1) {
    if (wordsLooselyEqual(aligned[i].word, want[0])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    return { start: null, end: null, matched: 0, cursor: startCursor };
  }

  let cursor = startIdx;
  let wi = 0;
  let start = null;
  let end = null;
  let consecutiveSkips = 0;
  const MAX_SKIPS = 3;

  while (cursor < aligned.length && wi < want.length) {
    const got = aligned[cursor];
    if (wordsLooselyEqual(got.word, want[wi])) {
      if (start == null) start = got.start;
      end = got.end;
      wi += 1;
      cursor += 1;
      consecutiveSkips = 0;
      continue;
    }

    // Whisper inserted a filler — skip it.
    if (consecutiveSkips < MAX_SKIPS) {
      cursor += 1;
      consecutiveSkips += 1;
      continue;
    }

    // Script word missing from Whisper — skip one want token if next matches.
    if (
      wi + 1 < want.length &&
      wordsLooselyEqual(got.word, want[wi + 1])
    ) {
      wi += 1;
      consecutiveSkips = 0;
      continue;
    }

    break;
  }

  return { start, end, matched: wi, cursor };
}

/**
 * Map punchy caption blocks onto Whisper word timings.
 * Falls back per-block (not whole remainder) when a single phrase is weak.
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

  const wordCount = (text) =>
    String(text)
      .split(/\s+/)
      .map(normalizeWord)
      .filter(Boolean).length;

  for (let bi = 0; bi < list.length; bi += 1) {
    const text = String(list[bi]);
    const want = text
      .split(/\s+/)
      .map(normalizeWord)
      .filter(Boolean);

    if (want.length === 0) continue;

    const hit = matchBlockWords(want, aligned, cursor);
    const need = Math.ceil(want.length * 0.5);
    const strong = hit.start != null && hit.end != null && hit.matched >= need;

    if (strong) {
      matchedBlocks += 1;
      cursor = hit.cursor;
      const prevEnd = out.length > 0 ? out[out.length - 1].end : 0;
      const safeStart = Math.max(prevEnd, Number(hit.start.toFixed(4)));
      let safeEnd = Math.max(safeStart + 0.12, Number(hit.end.toFixed(4)));
      if (bi === list.length - 1) {
        safeEnd = Math.max(safeEnd, duration);
      }
      out.push({
        start: safeStart,
        end: Math.min(duration, safeEnd),
        text,
      });
      continue;
    }

    // Weak block: time only this phrase by remaining word share, keep aligning later.
    const remainingBlocks = list.slice(bi);
    const remWords =
      remainingBlocks.reduce((sum, b) => sum + Math.max(1, wordCount(b)), 0) || 1;
    const prevEnd = out.length > 0 ? out[out.length - 1].end : 0;
    const remDur = Math.max(0.2, duration - prevEnd);
    const blockDur = Math.max(
      0.15,
      (Math.max(1, want.length) / remWords) * remDur
    );
    const safeStart = prevEnd;
    const safeEnd =
      bi === list.length - 1
        ? duration
        : Math.min(duration, Number((safeStart + blockDur).toFixed(4)));
    out.push({ start: safeStart, end: safeEnd, text });

    // If we partially matched, advance cursor so later blocks stay in sync.
    if (hit.matched > 0) {
      cursor = hit.cursor;
    }
  }

  if (matchedBlocks < Math.ceil(list.length * 0.35)) {
    return computeCaptionTimings(list, duration);
  }

  if (out.length > 0) {
    out[out.length - 1].end = duration;
  }
  return out;
}

/**
 * Build caption timings from audio when possible; otherwise proportional.
 * Prefer whispering raw TTS, then scale into fitted duration via timeScale.
 *
 * @param {string[]} blocks
 * @param {string} audioPath path passed to Whisper (raw TTS preferred)
 * @param {number} totalDuration fitted / mux duration
 * @param {{ timeScale?: number }} [opts] fittedDuration / rawDuration
 */
export async function resolveCaptionTimings(
  blocks,
  audioPath,
  totalDuration,
  opts = {}
) {
  try {
    let words = await transcribeWords(audioPath);
    const scale = Number(opts.timeScale);
    if (Number.isFinite(scale) && Math.abs(scale - 1) >= 0.001) {
      words = scaleWordTimings(words, scale);
    }
    const timings = timingsFromWordAlignment(blocks, words, totalDuration);
    console.log(
      JSON.stringify({
        event: "caption_align_ok",
        blocks: blocks.length,
        whisper_words: words.length,
        time_scale: Number.isFinite(scale) ? Number(scale.toFixed(4)) : 1,
      })
    );
    return timings;
  } catch (err) {
    console.warn("caption align fallback:", err?.message || err);
    return computeCaptionTimings(blocks, totalDuration);
  }
}
