/**
 * Split narration into sentence-ish chunks for timing weights.
 * @param {string} script
 * @returns {string[]}
 */
export function splitScriptSentences(script) {
  const text = String(script || "").trim();
  if (!text) return [];
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

/**
 * Word-count weight for a text chunk (minimum 1).
 * @param {string} text
 */
export function wordWeight(text) {
  const n = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, n);
}

/**
 * Compute per-beat on-screen durations that sum to totalSeconds.
 *
 * Priority:
 * 1. Explicit weights (length === beatCount)
 * 2. Script sentence word counts mapped onto beats
 * 3. Equal share
 *
 * @param {number} totalSeconds
 * @param {number} beatCount
 * @param {{ weights?: number[], script?: string }} [opts]
 * @returns {number[]}
 */
export function computeSegmentDurations(totalSeconds, beatCount, opts = {}) {
  const n = Math.max(1, Math.floor(Number(beatCount) || 1));
  const total = Math.max(0.5, Number(totalSeconds) || 0);

  let weights = null;

  if (Array.isArray(opts.weights) && opts.weights.length === n) {
    weights = opts.weights.map((w) => {
      const num = Number(w);
      return Number.isFinite(num) && num > 0 ? num : 1;
    });
  } else if (opts.script) {
    const sentences = splitScriptSentences(opts.script);
    weights = Array.from({ length: n }, (_, i) => {
      if (sentences.length === 0) return 1;
      // Map beat i → sentence(s) covering that portion of the script
      const start = Math.floor((i * sentences.length) / n);
      const end = Math.floor(((i + 1) * sentences.length) / n);
      const slice = sentences.slice(start, Math.max(start + 1, end));
      return slice.reduce((sum, s) => sum + wordWeight(s), 0) || 1;
    });
  } else {
    weights = Array.from({ length: n }, () => 1);
  }

  const sum = weights.reduce((a, b) => a + b, 0) || n;
  const raw = weights.map((w) => (total * w) / sum);

  // Ensure each segment is at least 0.8s; redistribute if needed
  const minSeg = Math.min(0.8, total / n);
  const adjusted = raw.map((d) => Math.max(minSeg, d));
  const adjSum = adjusted.reduce((a, b) => a + b, 0);
  const scale = total / adjSum;

  return adjusted.map((d) => Number((d * scale).toFixed(3)));
}
