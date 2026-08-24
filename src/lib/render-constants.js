/** Shared render/queue constants (API + worker). */

export const LEASE_SECONDS = 180;
export const MAX_ATTEMPTS_DEFAULT = 3;
export const RENDERS_BUCKET = "renders";

export const TTS_VOICE_BY_TONE = {
  Moody: "onyx",
  Corporate: "alloy",
  Cinematic: "nova",
};

export const SUBTITLE_THEMES = {
  "Viral Yellow": {
    color: "#FFE600",
    strokeWidth: 5,
    strokeColor: "#000000",
    textTransform: "uppercase",
    letterSpacing: 1.5,
  },
  "Cyberpunk Neon": {
    color: "#00F0FF",
    strokeWidth: 5,
    strokeColor: "#FF00AA",
    textTransform: "uppercase",
    letterSpacing: 2,
  },
  "Clean Minimalist": {
    color: "#FFFFFF",
    strokeWidth: 5,
    strokeColor: "#000000",
    textTransform: "none",
    letterSpacing: 0.5,
  },
};

/**
 * @param {number} attempt - attempts count after the failure (1-based for backoff)
 */
export function computeBackoffSeconds(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(180, Math.round(30 * 1.5 ** n));
}

/**
 * Classify whether a render error should auto-retry.
 * @param {unknown} err
 */
export function isRetryableError(err) {
  if (!err) return false;

  const status = Number(err.status ?? err.statusCode ?? err.code);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;

  const msg = String(err.message || err || "").toLowerCase();
  if (!msg) return false;

  const nonRetryable = [
    "invalid payload",
    "empty script",
    "missing env",
    "not configured",
    "ffmpeg is not installed",
    "unauthorized",
    "forbidden",
    "bad request",
  ];
  if (nonRetryable.some((s) => msg.includes(s))) return false;

  const retryable = [
    "timeout",
    "etimedout",
    "econnreset",
    "econnrefused",
    "network",
    "fetch failed",
    "socket",
    "temporarily",
    "rate limit",
    "429",
    "503",
    "502",
    "oom",
    "out of memory",
    "enospc",
    "no space",
  ];
  return retryable.some((s) => msg.includes(s));
}
