import crypto from "node:crypto";
import { NextResponse } from "next/server";
import {
  buildTopupVariantSet,
  creditsForVariantId,
  extractClerkUserId,
  extractVariantId,
} from "@/lib/billing-plans";
import {
  clearSubscribedFlag,
  grantCreditsForClerkUser,
} from "@/lib/user-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifyLemonSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(String(signatureHeader), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(request) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("LEMONSQUEEZY_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-signature") || "";

  if (!verifyLemonSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const eventName = payload?.meta?.event_name;
  const clerkUserId = extractClerkUserId(payload);

  try {
    if (
      eventName === "subscription_cancelled" ||
      eventName === "subscription_expired"
    ) {
      if (clerkUserId) await clearSubscribedFlag(clerkUserId);
      return NextResponse.json({ ok: true });
    }

    // Subscription payments (initial + renewals).
    if (eventName === "subscription_payment_success") {
      if (!clerkUserId) {
        console.warn("Lemon webhook missing custom user_id", eventName);
        return NextResponse.json({ ok: true, skipped: "no_user" });
      }
      const variantId = extractVariantId(payload);
      const credits = creditsForVariantId(variantId);
      if (!credits) {
        console.warn("Lemon webhook unknown subscription variant", variantId);
        return NextResponse.json({ ok: true, skipped: "unknown_variant" });
      }
      await grantCreditsForClerkUser(clerkUserId, credits, { markSubscribed: true });
      return NextResponse.json({ ok: true, granted: credits });
    }

    // One-time top-ups only (variant must be listed in *_TOPUP env).
    if (eventName === "order_created") {
      if (!clerkUserId) {
        console.warn("Lemon webhook missing custom user_id", eventName);
        return NextResponse.json({ ok: true, skipped: "no_user" });
      }

      const status = payload?.data?.attributes?.status;
      if (status && status !== "paid") {
        return NextResponse.json({ ok: true, skipped: "not_paid" });
      }

      const variantId = extractVariantId(payload);
      const topups = buildTopupVariantSet();
      if (!variantId || !topups.has(String(variantId))) {
        return NextResponse.json({ ok: true, skipped: "not_topup" });
      }

      const credits = creditsForVariantId(variantId);
      if (!credits) {
        console.warn("Lemon webhook unknown top-up variant", variantId);
        return NextResponse.json({ ok: true, skipped: "unknown_variant" });
      }

      await grantCreditsForClerkUser(clerkUserId, credits, { markSubscribed: false });
      return NextResponse.json({ ok: true, granted: credits });
    }

    return NextResponse.json({ ok: true, ignored: eventName });
  } catch (error) {
    console.error("Lemon webhook handler error:", error);
    return NextResponse.json(
      { error: error.message || "Webhook handler failed." },
      { status: 500 }
    );
  }
}
