/** Locked packs: Starter ~3 videos/$, Creator ~4 videos/$ ($15 → 60). */

export const BILLING_PACKS = {
  starter: { id: "starter", label: "Starter", priceUsd: 5, credits: 15 },
  creator: { id: "creator", label: "Creator", priceUsd: 15, credits: 60 },
};

/**
 * Map Paddle price id → credit grant.
 * Sub and top-up prices for the same pack share the same credit amount.
 */
export function buildPriceCreditMap(env = process.env) {
  /** @type {Map<string, number>} */
  const map = new Map();

  function add(raw, credits) {
    if (!raw) return;
    for (const part of String(raw).split(",")) {
      const id = part.trim();
      if (id) map.set(id, credits);
    }
  }

  add(env.NEXT_PUBLIC_PADDLE_PRICE_STARTER, BILLING_PACKS.starter.credits);
  add(env.PADDLE_PRICE_STARTER, BILLING_PACKS.starter.credits);
  add(env.NEXT_PUBLIC_PADDLE_PRICE_STARTER_TOPUP, BILLING_PACKS.starter.credits);
  add(env.PADDLE_PRICE_STARTER_TOPUP, BILLING_PACKS.starter.credits);
  add(env.NEXT_PUBLIC_PADDLE_PRICE_CREATOR, BILLING_PACKS.creator.credits);
  add(env.PADDLE_PRICE_CREATOR, BILLING_PACKS.creator.credits);
  add(env.NEXT_PUBLIC_PADDLE_PRICE_CREATOR_TOPUP, BILLING_PACKS.creator.credits);
  add(env.PADDLE_PRICE_CREATOR_TOPUP, BILLING_PACKS.creator.credits);

  return map;
}

export function creditsForPriceId(priceId, env = process.env) {
  if (priceId == null || priceId === "") return null;
  const map = buildPriceCreditMap(env);
  if (map.has(String(priceId))) return map.get(String(priceId));
  return null;
}

/** @deprecated Use creditsForPriceId */
export function creditsForVariantId(priceId, env = process.env) {
  return creditsForPriceId(priceId, env);
}

/** Price ids that are one-time top-ups (not subscriptions). */
export function buildTopupPriceSet(env = process.env) {
  const set = new Set();
  for (const raw of [
    env.NEXT_PUBLIC_PADDLE_PRICE_STARTER_TOPUP,
    env.PADDLE_PRICE_STARTER_TOPUP,
    env.NEXT_PUBLIC_PADDLE_PRICE_CREATOR_TOPUP,
    env.PADDLE_PRICE_CREATOR_TOPUP,
  ]) {
    if (!raw) continue;
    for (const part of String(raw).split(",")) {
      const id = part.trim();
      if (id) set.add(id);
    }
  }
  return set;
}

/** @deprecated Use buildTopupPriceSet */
export function buildTopupVariantSet(env = process.env) {
  return buildTopupPriceSet(env);
}

/** Public Paddle price ids for checkout overlay. */
export function getPaddlePriceIds(env = process.env) {
  return {
    starterSub:
      env.NEXT_PUBLIC_PADDLE_PRICE_STARTER || env.PADDLE_PRICE_STARTER || "",
    creatorSub:
      env.NEXT_PUBLIC_PADDLE_PRICE_CREATOR || env.PADDLE_PRICE_CREATOR || "",
    starterTopup:
      env.NEXT_PUBLIC_PADDLE_PRICE_STARTER_TOPUP ||
      env.PADDLE_PRICE_STARTER_TOPUP ||
      "",
    creatorTopup:
      env.NEXT_PUBLIC_PADDLE_PRICE_CREATOR_TOPUP ||
      env.PADDLE_PRICE_CREATOR_TOPUP ||
      "",
  };
}

/** @deprecated Prefer getPaddlePriceIds + openPaddleCheckout */
export function getCheckoutBases(env = process.env) {
  const prices = getPaddlePriceIds(env);
  return {
    starterSub: prices.starterSub,
    creatorSub: prices.creatorSub,
    starterTopup: prices.starterTopup,
    creatorTopup: prices.creatorTopup,
  };
}

/**
 * @deprecated Lemon-style URL helper — Paddle uses overlay checkout.
 * Returns "#" when empty so UI can fall back to paywall.
 */
export function withCheckoutUser(priceIdOrUrl, _clerkUserId) {
  const trimmed = String(priceIdOrUrl || "").trim();
  if (!trimmed || trimmed === "#") return "#";
  return trimmed;
}

/**
 * Extract Paddle price id(s) from a transaction.completed payload.
 * @param {object} data transaction entity
 * @returns {string[]}
 */
export function extractPriceIds(data) {
  const items = data?.items;
  if (!Array.isArray(items)) return [];
  /** @type {string[]} */
  const ids = [];
  for (const item of items) {
    const id = item?.price?.id ?? item?.price_id;
    if (id != null && id !== "") ids.push(String(id));
  }
  return ids;
}

/** @deprecated Use extractPriceIds */
export function extractVariantId(payload) {
  const data = payload?.data ?? payload;
  const ids = extractPriceIds(data);
  return ids[0] ?? null;
}

/**
 * @param {object} dataOrPayload transaction/subscription entity or full event
 * @returns {string | null} Clerk user id from custom data
 */
export function extractClerkUserId(dataOrPayload) {
  const custom =
    dataOrPayload?.data?.custom_data ??
    dataOrPayload?.custom_data ??
    dataOrPayload?.meta?.custom_data;
  if (!custom || typeof custom !== "object") return null;
  const id = custom.user_id ?? custom.clerk_user_id;
  if (id == null || id === "") return null;
  return String(id);
}
