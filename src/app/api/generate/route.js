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
  VIDEO_DURATIONS,
  ASPECT_RATIOS,
  resolveCaptionsEnabled,
  resolveTtsVoice,
  resolveTargetDuration,
  resolveAspectRatio,
} from "@/lib/render-constants";
import { planVisualBeats } from "@/lib/visual-queries";
import { fetchBrollForQueries } from "@/lib/pexels-broll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

async function draftScript(topic, tone, targetDurationSeconds) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }

  const toneGuide =
    VIDEO_TONES[tone]?.scriptGuide || VIDEO_TONES.Cinematic.scriptGuide;
  const durationMeta =
    VIDEO_DURATIONS[targetDurationSeconds] || VIDEO_DURATIONS[45];

  const response = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.85,
      messages: [
        {
          role: "system",
          content: `You write punchy short-form video scripts for about ${durationMeta.seconds} seconds of spoken narration (~${durationMeta.wordRange} words).

Hard rules:
- Write exactly ${durationMeta.sentenceRange || "4 to 8"} short sentences (each ends with . ! or ?).
- Aim for about ${durationMeta.wordRange} spoken words so narration fills ~${durationMeta.seconds} seconds (do not write a short 30s script when the target is longer).
- Prefer one clear action or image per sentence (easier to match B-roll).
- Every sentence must be filmable: name concrete objects, places, hands, or actions a stock camera can show.
- Do NOT write abstract-only lines (success, mindset, growth, vibes, innovation, battleground, creativity, focus, inspiration, hustle) unless tied to a visible action.
- The final sentence must still be filmable (a concrete closing image), never a slogan or metaphor.
- Prefer common stock-video actions (pour coffee, stir, type, walk, open a notebook, push-ups, squats, jumping jacks) over rare ones.
- For workouts / how-tos: one named exercise or step per sentence (e.g. "Do bodyweight squats on the floor."). Avoid form lectures ("knees behind toes"), timers-as-subject, and multi-move lines.
- Honor topic constraints (e.g. no equipment → bodyweight / home, never gym machines).
- Return clean plain text only — no markdown, no bullets, no quotes, no labels, no stage directions.`,
        },
        {
          role: "user",
          content: `Topic/niche: ${topic}
Tone: ${tone}. ${toneGuide}
Target length: ${durationMeta.seconds} seconds (~${durationMeta.wordRange} spoken words, ${durationMeta.sentenceRange || "4–8"} sentences).
Write filmable sentences that vertical stock B-roll can illustrate line by line. Prefer actions Pexels commonly has. Fill the full target length — end on a concrete image, not a motivational closer.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("OpenAI error:", detail);
    throw new Error("Failed to draft script with OpenAI.");
  }

  const data = await response.json();
  const script = data?.choices?.[0]?.message?.content?.trim();
  if (!script) throw new Error("OpenAI returned an empty script.");

  return script.replace(/^```[\s\S]*?```$/g, "").trim();
}

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

    const profile = await ensureUserProfile(userId);

    if (!canGenerate(profile)) {
      return NextResponse.json(
        {
          code: "PAYWALL_REQUIRED",
          error: "Free credits exhausted. Upgrade to continue generating.",
        },
        { status: 403 }
      );
    }

    // 1) Filmable script  2) One B-roll query per spoken line  3) Pexels per beat
    const script = await draftScript(topic, tone, targetDurationSeconds);
    const visualPlan = await planVisualBeats(script, topic);
    const { pexelsVideoUrls, visualBeats } = await fetchBrollForQueries(
      visualPlan.queries,
      {
        weights: visualPlan.weights,
        lines: visualPlan.lines,
        motif: visualPlan.motif,
        orientation: ASPECT_RATIOS[aspectRatio]?.orientation,
      }
    );

    let updatedProfile;
    try {
      updatedProfile = await deductCreditIfNeeded(profile);
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
      script,
      pexelsVideoUrls,
      visualBeats,
      visualQueries: visualPlan.queries,
      visualLines: visualPlan.lines,
      visualMotif: visualPlan.motif,
      visualAvoid: visualPlan.avoid,
      tone,
      subtitleTheme,
      voice,
      captionsEnabled,
      targetDurationSeconds,
      aspectRatio,
    };

    const { data: videoRow, error: videoError } = await supabase
      .from("videos")
      .insert({
        user_id: updatedProfile.id,
        clerk_user_id: userId,
        prompt: topic,
        tone,
        subtitle_theme: subtitleTheme,
        script,
        render_id: null,
        video_url: null,
        thumbnail_url: null,
        status: "pending",
        attempts: 0,
        max_attempts: MAX_ATTEMPTS_DEFAULT,
        next_visible_at: new Date().toISOString(),
        payload,
        error: null,
        credit_refunded: false,
      })
      .select("id, prompt, status, created_at")
      .single();

    if (videoError) {
      console.error("Supabase video insert error:", videoError);
      if (!updatedProfile.is_premium) {
        await supabase.rpc("refund_free_credit", { p_user_id: updatedProfile.id });
      }
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
      script,
      visualMotif: visualPlan.motif,
      visualBeats: visualBeats.map((b) => ({
        query: b.query,
        weight: b.weight,
        line: b.line || null,
        verified: Boolean(b.verified),
        retried: Boolean(b.retried),
      })),
      freeCreditsRemaining: updatedProfile.free_credits_remaining,
      isPremium: updatedProfile.is_premium,
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
