/** Classify worker render failures as retryable (transient) or terminal. */
export function isRetryableError(err) {
  const status = Number(err?.status ?? err?.statusCode ?? err?.code);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(err?.message || err || "").toLowerCase();
  const nonRetryable = [
    "invalid payload",
    "not configured",
    "ffmpeg is not installed",
  ];
  if (nonRetryable.some((s) => msg.includes(s))) return false;
  // empty script without prepare is a bug; prepare API misses are retryable via status
  if (msg.includes("empty script") && !msg.includes("openai")) return false;
  const retryable = [
    "timeout",
    "etimedout",
    "econnreset",
    "network",
    "fetch failed",
    "rate limit",
    "oom",
  ];
  return retryable.some((s) => msg.includes(s));
}
