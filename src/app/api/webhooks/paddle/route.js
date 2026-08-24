import { NextResponse } from "next/server";
import {
  buildTopupPriceSet,
  creditsForPriceId,
  extractClerkUserId,
  extractPriceIds,
} from "@/lib/billing-plans";
import { verifyPaddleSignature } from "@/lib/paddle-webhook";
import {
  clearSubscribedFlag,
  grantCreditsForClerkUser,
} from "@/lib/user-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("PADDLE_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Webhook not configured." }, { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("paddle-signature") || "";

  if (!verifyPaddleSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const eventType = event?.event_type;
  const data = event?.data;

  try {
    if (
      eventType === "subscription.canceled" ||
      eventType === "subscription.cancelled"
    ) {
      const clerkUserId = extractClerkUserId(data) || extractClerkUserId(event);
      if (clerkUserId) await clearSubscribedFlag(clerkUserId);
      return NextResponse.json({ ok: true });
    }

    // Initial sub, renewals, and one-time top-ups all complete as transactions.
    if (eventType === "transaction.completed") {
      const clerkUserId = extractClerkUserId(data) || extractClerkUserId(event);
      if (!clerkUserId) {
        console.warn("Paddle webhook missing custom user_id", eventType);
        return NextResponse.json({ ok: true, skipped: "no_user" });
      }

      const priceIds = extractPriceIds(data);
      if (priceIds.length === 0) {
        return NextResponse.json({ ok: true, skipped: "no_price" });
      }

      const topups = buildTopupPriceSet();
      let granted = 0;
      let markSubscribed = false;

      for (const priceId of priceIds) {
        const credits = creditsForPriceId(priceId);
        if (!credits) {
          console.warn("Paddle webhook unknown price", priceId);
          continue;
        }
        granted += credits;
        if (!topups.has(String(priceId))) {
          markSubscribed = true;
        }
      }

      if (!granted) {
        return NextResponse.json({ ok: true, skipped: "unknown_price" });
      }

      await grantCreditsForClerkUser(clerkUserId, granted, { markSubscribed });
      return NextResponse.json({ ok: true, granted });
    }

    return NextResponse.json({ ok: true, ignored: eventType });
  } catch (error) {
    console.error("Paddle webhook handler error:", error);
    return NextResponse.json(
      { error: error.message || "Webhook handler failed." },
      { status: 500 }
    );
  }
}
