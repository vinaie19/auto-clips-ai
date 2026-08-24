import crypto from "node:crypto";

const MAX_AGE_SECONDS = 300;

/**
 * Verify Paddle Billing webhook signature (Paddle-Signature: ts=…;h1=…).
 * @param {string} rawBody
 * @param {string} signatureHeader
 * @param {string} secret
 * @param {{ nowSec?: number, maxAgeSec?: number }} [opts]
 */
export function verifyPaddleSignature(
  rawBody,
  signatureHeader,
  secret,
  opts = {}
) {
  if (!secret || !signatureHeader || rawBody == null) return false;

  let ts = "";
  /** @type {string[]} */
  const h1s = [];
  for (const part of String(signatureHeader).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "ts") ts = value;
    if (key === "h1") h1s.push(value);
  }
  if (!ts || h1s.length === 0) return false;

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSec ?? MAX_AGE_SECONDS;
  const age = Math.abs(nowSec - Number(ts));
  if (!Number.isFinite(age) || age > maxAge) return false;

  const signedPayload = `${ts}:${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");

  for (const h1 of h1s) {
    const got = Buffer.from(h1, "utf8");
    if (got.length === expectedBuf.length && crypto.timingSafeEqual(got, expectedBuf)) {
      return true;
    }
  }
  return false;
}
