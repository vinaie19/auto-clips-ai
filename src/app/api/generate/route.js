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
  TTS_VOICE_BY_TONE,
} from "@/lib/render-constants";
import { deriveVisualQueries } from "@/lib/visual-queries";
import { fetchBrollForQueries } from "@/lib/pexels-broll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

const TONE_PROMPTS = {
  Moody:
    "Write in a moody, atmospheric narrator voice — intimate, reflective, cinematic tension.",
  Corporate:
    "Write in a polished corporate narrator voice — clear, confident, professional, benefit-led.",
  Cinematic:
    "Write in a cinematic, dramatic narrator voice — vivid imagery, measured pacing, high stakes.",
};

async function draftScript(topic, tone) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }

  const toneGuide = TONE_PROMPTS[tone] || TONE_PROMPTS.Cinematic;

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
          content:
            "You write punchy vertical short-form video scripts for about 45 seconds of spoken narration. Return clean plain text only — no markdown, no bullet points, no quotes, no labels, no stage directions.",
        },
        {
          role: "user",
          content: `Topic/niche: ${topic}\nTone: ${tone}. ${toneGuide}\nWrite a tight script of roughly 110–130 spoken words across 3–5 short sentences.`,
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

    if (!topic) {
      return NextResponse.json({ error: "topic is required." }, { status: 400 });
    }

    if (!Object.keys(TONE_PROMPTS).includes(tone)) {
      return NextResponse.json(
        { error: "tone must be Moody, Corporate, or Cinematic." },
        { status: 400 }
      );
    }

    if (!Object.keys(SUBTITLE_THEMES).includes(subtitleTheme)) {
      return NextResponse.json(
        {
          error:
            "subtitleTheme must be Viral Yellow, Cyberpunk Neon, or Clean Minimalist.",
        },
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

    // 1) Script  2) Visual queries from script  3) One Pexels clip per beat
    const script = await draftScript(topic, tone);
    const visualQueries = await deriveVisualQueries(script, topic);
    const { pexelsVideoUrls, visualBeats } = await fetchBrollForQueries(visualQueries);
    const voice = TTS_VOICE_BY_TONE[tone] || TTS_VOICE_BY_TONE.Cinematic;

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
      visualQueries,
      tone,
      subtitleTheme,
      voice,
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
      visualBeats: visualBeats.map((b) => ({ query: b.query })),
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
