import { describe, expect, it } from "vitest";
import {
  BILLING_PACKS,
  FREE_CREDITS_DEFAULT,
  buildTopupPriceSet,
  creditsForPriceId,
  extractClerkUserId,
  extractPriceIds,
} from "@/lib/billing-plans";
import { verifyPaddleSignature } from "@/lib/paddle-webhook";
import crypto from "node:crypto";

describe("billing-plans (Paddle)", () => {
  it("exposes locked pack sizes", () => {
    expect(BILLING_PACKS.starter.credits).toBe(30);
    expect(BILLING_PACKS.creator.credits).toBe(100);
    expect(FREE_CREDITS_DEFAULT).toBe(6);
  });

  it("maps price ids to credits from env", () => {
    const env = {
      NEXT_PUBLIC_PADDLE_PRICE_STARTER: "pri_starter",
      NEXT_PUBLIC_PADDLE_PRICE_STARTER_TOPUP: "pri_starter_top",
      NEXT_PUBLIC_PADDLE_PRICE_CREATOR: "pri_creator",
      NEXT_PUBLIC_PADDLE_PRICE_CREATOR_TOPUP: "pri_creator_top",
    };
    expect(creditsForPriceId("pri_starter", env)).toBe(30);
    expect(creditsForPriceId("pri_starter_top", env)).toBe(30);
    expect(creditsForPriceId("pri_creator", env)).toBe(100);
    expect(creditsForPriceId("pri_creator_top", env)).toBe(100);
    expect(creditsForPriceId("pri_unknown", env)).toBeNull();
  });

  it("builds top-up price set", () => {
    const set = buildTopupPriceSet({
      NEXT_PUBLIC_PADDLE_PRICE_STARTER_TOPUP: "pri_a",
      NEXT_PUBLIC_PADDLE_PRICE_CREATOR_TOPUP: "pri_b,pri_c",
    });
    expect(set.has("pri_a")).toBe(true);
    expect(set.has("pri_b")).toBe(true);
    expect(set.has("pri_c")).toBe(true);
    expect(set.has("pri_starter")).toBe(false);
  });

  it("extracts price ids and user from transaction payload", () => {
    const data = {
      custom_data: { user_id: "clerk_abc" },
      items: [{ price: { id: "pri_starter_top" }, quantity: 1 }],
    };
    expect(extractClerkUserId(data)).toBe("clerk_abc");
    expect(extractPriceIds(data)).toEqual(["pri_starter_top"]);
  });
});

describe("verifyPaddleSignature", () => {
  it("accepts a valid signature within the time window", () => {
    const secret = "pdl_ntfset_test";
    const rawBody = '{"event_type":"transaction.completed"}';
    const ts = 1_700_000_000;
    const h1 = crypto
      .createHmac("sha256", secret)
      .update(`${ts}:${rawBody}`)
      .digest("hex");
    expect(
      verifyPaddleSignature(rawBody, `ts=${ts};h1=${h1}`, secret, {
        nowSec: ts + 10,
      })
    ).toBe(true);
  });

  it("rejects wrong secrets and stale timestamps", () => {
    const secret = "pdl_ntfset_test";
    const rawBody = "{}";
    const ts = 1_700_000_000;
    const h1 = crypto
      .createHmac("sha256", secret)
      .update(`${ts}:${rawBody}`)
      .digest("hex");
    expect(
      verifyPaddleSignature(rawBody, `ts=${ts};h1=${h1}`, "wrong", {
        nowSec: ts,
      })
    ).toBe(false);
    expect(
      verifyPaddleSignature(rawBody, `ts=${ts};h1=${h1}`, secret, {
        nowSec: ts + 10_000,
      })
    ).toBe(false);
  });
});
