/** Locked AutoClips packs: Starter ~3 videos/$, Creator ~4 videos/$ ($15 → 60). */

export const BILLING_PACKS = {
  starter: { id: "starter", label: "Starter", priceUsd: 5, credits: 15 },
  creator: { id: "creator", label: "Creator", priceUsd: 15, credits: 60 },
};

/**
 * Map LemonSqueezy variant id → credit grant.
 * Sub and top-up variants for the same pack share the same credit amount.
 */
export function buildVariantCreditMap(env = process.env) {
  /** @type {Map<string, number>} */
  const map = new Map();

  function add(raw, credits) {
    if (!raw) return;
    for (const part of String(raw).split(",")) {
      const id = part.trim();
      if (id) map.set(id, credits);
    }
  }

  add(env.LEMON_VARIANT_STARTER, BILLING_PACKS.starter.credits);
  add(env.LEMON_VARIANT_STARTER_TOPUP, BILLING_PACKS.starter.credits);
  add(env.LEMON_VARIANT_CREATOR, BILLING_PACKS.creator.credits);
  add(env.LEMON_VARIANT_CREATOR_TOPUP, BILLING_PACKS.creator.credits);

  return map;
}

export function creditsForVariantId(variantId, env = process.env) {
  if (variantId == null || variantId === "") return null;
  const map = buildVariantCreditMap(env);
  if (map.has(String(variantId))) return map.get(String(variantId));
  return null;
}

/** Variant ids that are one-time top-ups (order_created grants). */
export function buildTopupVariantSet(env = process.env) {
  const set = new Set();
  for (const raw of [
    env.LEMON_VARIANT_STARTER_TOPUP,
    env.LEMON_VARIANT_CREATOR_TOPUP,
  ]) {
    if (!raw) continue;
    for (const part of String(raw).split(",")) {
      const id = part.trim();
      if (id) set.add(id);
    }
  }
  return set;
}

/** Public checkout base URLs (no custom data yet). */
export function getCheckoutBases(env = process.env) {
  return {
    starterSub: env.NEXT_PUBLIC_LEMON_CHECKOUT_STARTER_SUB || "",
    creatorSub: env.NEXT_PUBLIC_LEMON_CHECKOUT_CREATOR_SUB || "",
    starterTopup: env.NEXT_PUBLIC_LEMON_CHECKOUT_STARTER_TOPUP || "",
    creatorTopup: env.NEXT_PUBLIC_LEMON_CHECKOUT_CREATOR_TOPUP || "",
  };
}

/**
 * Append Clerk user id as Lemon custom data for webhook mapping.
 * @param {string} baseUrl
 * @param {string | null | undefined} clerkUserId
 */
export function withCheckoutUser(baseUrl, clerkUserId) {
  const trimmed = String(baseUrl || "").trim();
  if (!trimmed || trimmed === "#") return "#";
  try {
    const url = new URL(trimmed);
    if (clerkUserId) {
      url.searchParams.set("checkout[custom][user_id]", String(clerkUserId));
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

/**
 * Extract variant id from a Lemon webhook payload (order or subscription invoice).
 * @param {object} payload
 * @returns {string | null}
 */
export function extractVariantId(payload) {
  const attrs = payload?.data?.attributes;
  if (!attrs || typeof attrs !== "object") return null;

  const firstItem = attrs.first_order_item;
  if (firstItem?.variant_id != null) return String(firstItem.variant_id);

  if (attrs.variant_id != null) return String(attrs.variant_id);

  const items = attrs.order_items || attrs.items;
  if (Array.isArray(items) && items[0]?.variant_id != null) {
    return String(items[0].variant_id);
  }

  return null;
}

/**
 * @param {object} payload
 * @returns {string | null} Clerk user id from checkout custom data
 */
export function extractClerkUserId(payload) {
  const custom = payload?.meta?.custom_data;
  if (!custom || typeof custom !== "object") return null;
  const id = custom.user_id ?? custom.clerk_user_id;
  if (id == null || id === "") return null;
  return String(id);
}
