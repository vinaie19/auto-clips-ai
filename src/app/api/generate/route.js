import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  canGenerate,
  deductCreditIfNeeded,
  ensureUserProfile,
} from "@/lib/user-credits";
import {
  MAX_ATTEMPTS_DEFAULT,
  SUBTITLE_THEMES,
  VIDEO_TONES,
  ASPECT_RATIOS,
  VISUAL_STYLE_IDS,
  resolveCaptionsEnabled,
  resolveTtsVoice,
  resolveTargetDuration,
  resolveAspectRatio,
  resolveVisualStyle,
  resolvePurpose,
  creditsForDuration,
} from "@/lib/render-constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Thin enqueue only — script/B-roll run on the worker. */
export const maxDuration = 30;

export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
    const tone = typeof body?.tone === "string" ? body.tone.trim() : "Cinematic";
    const subtitleTheme =
      typeof body?.subtitleTheme === "string"
        ? body.subtitleTheme.trim()
        : "Viral Yellow";
    const captionsEnabled = resolveCaptionsEnabled(body?.captionsEnabled);
    const voice = resolveTtsVoice(body?.voice, tone);
    const targetDurationSeconds = resolveTargetDuration(body?.targetDurationSeconds);
    const aspectRatio = resolveAspectRatio(body?.aspectRatio);
    const visualStyle = resolveVisualStyle(body?.visualStyle);
    const purpose = resolvePurpose(tone);

    if (!topic) {
      return NextResponse.json({ error: "topic is required." }, { status: 400 });
    }

    if (!Object.keys(VIDEO_TONES).includes(tone)) {
      return NextResponse.json(
        {
          error: `tone must be one of: ${Object.keys(VIDEO_TONES).join(", ")}.`,
        },
        { status: 400 }
      );
    }

    if (!Object.keys(SUBTITLE_THEMES).includes(subtitleTheme)) {
      return NextResponse.json(
        {
          error: `subtitleTheme must be one of: ${Object.keys(SUBTITLE_THEMES).join(", ")}.`,
        },
        { status: 400 }
      );
    }

    if (!Object.keys(ASPECT_RATIOS).includes(aspectRatio)) {
      return NextResponse.json(
        { error: "aspectRatio must be 9:16, 16:9, or 1:1." },
        { status: 400 }
      );
    }

    if (visualStyle === undefined) {
      return NextResponse.json(
        {
          error: `visualStyle must be one of: ${VISUAL_STYLE_IDS.join(", ")} (or "auto"/omit).`,
        },
        { status: 400 }
      );
    }

    const profile = await ensureUserProfile(userId);
    const creditCost = creditsForDuration(targetDurationSeconds);

    if (!canGenerate(profile, creditCost)) {
      return NextResponse.json(
        {
          code: "PAYWALL_REQUIRED",
          error: "Not enough credits for this duration. Upgrade or top up to continue.",
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

    const supabase = getSupabaseAdmin();
    const payload = {
      topic,
      tone,
      subtitleTheme,
      voice,
      captionsEnabled,
      targetDurationSeconds,
      aspectRatio,
      // Auto/absent → omit visualStyle so the worker resolves via PURPOSE_STYLE_DEFAULT (F7)
      ...(visualStyle ? { visualStyle } : {}),
      purpose,
    };

    const { data: videoRow, error: videoError } = await supabase
      .from("videos")
      .insert({
        user_id: updatedProfile.id,
        clerk_user_id: userId,
        prompt: topic,
        tone,
        subtitle_theme: subtitleTheme,
        script: null,
        render_id: null,
        video_url: null,
        thumbnail_url: null,
        status: "pending",
        attempts: 0,
        max_attempts: MAX_ATTEMPTS_DEFAULT,
        next_visible_at: new Date().toISOString(),
        payload,
        error: null,
        progress: "queued",
        credit_refunded: false,
        credits_charged: creditCost,
      })
      .select("id, prompt, status, created_at")
      .single();

    if (videoError) {
      console.error("Supabase video insert error:", videoError);
      await supabase.rpc("refund_free_credit", {
        p_user_id: updatedProfile.id,
        p_amount: creditCost,
      });
      throw new Error("Failed to queue render job.");
    }

    await supabase
      .from("videos")
      .update({ render_id: videoRow.id })
      .eq("id", videoRow.id);

    return NextResponse.json({
      renderId: videoRow.id,
      videoId: videoRow.id,
      statusUrl: `/api/generate/status?id=${encodeURIComponent(videoRow.id)}`,
      script: null,
      visualMotif: null,
      visualBeats: [],
      freeCreditsRemaining: updatedProfile.free_credits_remaining,
      isPremium: updatedProfile.is_premium,
      creditsCharged: creditCost,
      message: "Render queued successfully.",
    });
  } catch (error) {
    console.error("POST /api/generate failed:", error);
    return NextResponse.json(
      { error: error.message || "Unable to generate video." },
      { status: 500 }
    );
  }
}
