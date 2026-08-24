import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  canGenerate,
  deductCreditIfNeeded,
  ensureUserProfile,
} from "@/lib/user-credits";
import { creditsForDuration } from "@/lib/render-constants";
import { manualRequeue } from "@/lib/render-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request, context) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const resolvedParams = await context.params;
    const videoId = resolvedParams?.id;
    if (!videoId) {
      return NextResponse.json({ error: "Video id is required." }, { status: 400 });
    }

    const profile = await ensureUserProfile(userId);
    const supabase = getSupabaseAdmin();

    const { data: video, error } = await supabase
      .from("videos")
      .select("id, status, clerk_user_id, payload, credits_charged")
      .eq("id", videoId)
      .eq("clerk_user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Retry load error:", error);
      return NextResponse.json({ error: "Failed to load video." }, { status: 500 });
    }

    if (!video) {
      return NextResponse.json({ error: "Video not found." }, { status: 404 });
    }

    if (video.status !== "failed") {
      return NextResponse.json(
        { error: "Only failed renders can be retried." },
        { status: 409 }
      );
    }

    const durationFromPayload = video.payload?.targetDurationSeconds;
    const creditCost = Math.max(
      1,
      Math.floor(Number(video.credits_charged)) ||
        creditsForDuration(durationFromPayload)
    );

    if (!canGenerate(profile, creditCost)) {
      return NextResponse.json(
        {
          code: "PAYWALL_REQUIRED",
          error: "Not enough credits to retry. Upgrade or top up to continue.",
        },
        { status: 403 }
      );
    }

    let updatedProfile;
    try {
      updatedProfile = await deductCreditIfNeeded(profile, creditCost);
    } catch (creditError) {
      if (creditError?.code === "PAYWALL_REQUIRED") {
        return NextResponse.json(
          {
            code: "PAYWALL_REQUIRED",
            error: creditError.message,
          },
          { status: 403 }
        );
      }
      throw creditError;
    }

    const requeued = await manualRequeue(videoId, { creditsCharged: creditCost });
    if (!requeued) {
      await supabase.rpc("refund_free_credit", {
        p_user_id: updatedProfile.id,
        p_amount: creditCost,
      });
      return NextResponse.json(
        { error: "Unable to requeue. The job may have changed status." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      renderId: requeued.id,
      videoId: requeued.id,
      statusUrl: `/api/generate/status?id=${encodeURIComponent(requeued.id)}`,
      freeCreditsRemaining: updatedProfile.free_credits_remaining,
      isPremium: updatedProfile.is_premium,
      creditsCharged: creditCost,
      message: "Render requeued successfully.",
    });
  } catch (error) {
    console.error("POST /api/videos/[id]/retry failed:", error);
    return NextResponse.json(
      { error: error.message || "Unable to retry render." },
      { status: 500 }
    );
  }
}
