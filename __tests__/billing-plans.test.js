import { describe, expect, it } from "vitest";
import {
  BILLING_PACKS,
  buildTopupVariantSet,
  creditsForVariantId,
  extractClerkUserId,
  extractVariantId,
  withCheckoutUser,
} from "@/lib/billing-plans";

describe("billing-plans", () => {
  it("exposes locked pack sizes", () => {
    expect(BILLING_PACKS.starter.credits).toBe(15);
    expect(BILLING_PACKS.creator.credits).toBe(60);
  });

  it("maps variant ids to credits from env", () => {
    const env = {
      LEMON_VARIANT_STARTER: "111",
      LEMON_VARIANT_STARTER_TOPUP: "112",
      LEMON_VARIANT_CREATOR: "221",
      LEMON_VARIANT_CREATOR_TOPUP: "222",
    };
    expect(creditsForVariantId("111", env)).toBe(15);
    expect(creditsForVariantId("112", env)).toBe(15);
    expect(creditsForVariantId("221", env)).toBe(60);
    expect(creditsForVariantId("222", env)).toBe(60);
    expect(creditsForVariantId("999", env)).toBeNull();
  });

  it("builds top-up variant set", () => {
    const set = buildTopupVariantSet({
      LEMON_VARIANT_STARTER_TOPUP: "112",
      LEMON_VARIANT_CREATOR_TOPUP: "222,223",
    });
    expect(set.has("112")).toBe(true);
    expect(set.has("222")).toBe(true);
    expect(set.has("223")).toBe(true);
    expect(set.has("111")).toBe(false);
  });

  it("appends clerk user id to checkout URL", () => {
    const url = withCheckoutUser(
      "https://autoclips.lemonsqueezy.com/checkout/buy/abc",
      "user_123"
    );
    expect(url).toContain("checkout%5Bcustom%5D%5Buser_id%5D=user_123");
  });

  it("extracts variant and user from webhook payload", () => {
    const payload = {
      meta: {
        event_name: "order_created",
        custom_data: { user_id: "clerk_abc" },
      },
      data: {
        attributes: {
          status: "paid",
          first_order_item: { variant_id: 112 },
        },
      },
    };
    expect(extractClerkUserId(payload)).toBe("clerk_abc");
    expect(extractVariantId(payload)).toBe("112");
  });
});
