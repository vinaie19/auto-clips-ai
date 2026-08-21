import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  canGenerate,
  deductCreditIfNeeded,
  ensureUserProfile,
} from "@/lib/user-credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SHOTSTACK_RENDER_URL = "https://api.shotstack.io/edit/v1/render";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const PEXELS_VIDEO_SEARCH_URL = "https://api.pexels.com/v1/videos/search";

const PEXELS_FALLBACK_CLIPS = [
  "https://videos.pexels.com/video-files/3045163/3045163-uhd_2560_1440_30fps.mp4",
  "https://videos.pexels.com/video-files/3571264/3571264-uhd_2560_1440_30fps.mp4",
  "https://videos.pexels.com/video-files/3209828/3209828-uhd_2560_1440_25fps.mp4",
  "https://videos.pexels.com/video-files/5532763/5532763-uhd_1440_2732_25fps.mp4",
];

const TONE_PROMPTS = {
  Moody:
    "Write in a moody, atmospheric narrator voice — intimate, reflective, cinematic tension.",
  Corporate:
    "Write in a polished corporate narrator voice — clear, confident, professional, benefit-led.",
  Cinematic:
    "Write in a cinematic, dramatic narrator voice — vivid imagery, measured pacing, high stakes.",
};

const TTS_VOICE_BY_TONE = {
  Moody: "Amy",
  Corporate: "Matthew",
  Cinematic: "Joey",
};

const SUBTITLE_THEMES = {
  "Viral Yellow": {
    color: "#FFE600",
    strokeWidth: 5,
    strokeColor: "#000000",
    textTransform: "uppercase",
    letterSpacing: 1.5,
  },
  "Cyberpunk Neon": {
    color: "#00F0FF",
    strokeWidth: 5,
    strokeColor: "#FF00AA",
    textTransform: "uppercase",
    letterSpacing: 2,
  },
  "Clean Minimalist": {
    color: "#FFFFFF",
    strokeWidth: 5,
    strokeColor: "#000000",
    textTransform: "none",
    letterSpacing: 0.5,
  },
};

function pickOptimalPortraitMp4(videoFiles) {
  const candidates = (videoFiles || [])
    .filter((file) => {
      const link = typeof file?.link === "string" ? file.link : "";
      const width = Number(file?.width) || 0;
      const isMp4 =
        file?.file_type === "video/mp4" || link.toLowerCase().includes(".mp4");
      return isMp4 && width >= 720 && width <= 1080;
    })
    .sort((a, b) => {
      const aPortraitBias = (Number(a.height) || 0) - (Number(a.width) || 0);
      const bPortraitBias = (Number(b.height) || 0) - (Number(b.width) || 0);
      if (bPortraitBias !== aPortraitBias) return bPortraitBias - aPortraitBias;
      return (Number(b.width) || 0) - (Number(a.width) || 0);
    });

  return candidates[0]?.link || null;
}

async function fetchPexelsVerticalClips(topic) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey || apiKey === "your_pexels_key_here") {
    throw new Error("PEXELS_API_KEY is not configured on the server.");
  }

  const searchUrl = `${PEXELS_VIDEO_SEARCH_URL}?query=${encodeURIComponent(topic)}&orientation=portrait&per_page=4`;

  const response = await fetch(searchUrl, {
    method: "GET",
    headers: { Authorization: apiKey },
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Pexels video search error:", detail);
    throw new Error("Failed to fetch vertical clips from Pexels.");
  }

  const data = await response.json();
  const videos = Array.isArray(data?.videos) ? data.videos : [];
  const urls = videos
    .map((video) => pickOptimalPortraitMp4(video?.video_files))
    .filter(Boolean);

  if (urls.length === 0) {
    return PEXELS_FALLBACK_CLIPS.slice(0, 4);
  }

  const filled = [...urls];
  let fallbackIndex = 0;
  while (filled.length < 3 && fallbackIndex < PEXELS_FALLBACK_CLIPS.length) {
    const next = PEXELS_FALLBACK_CLIPS[fallbackIndex];
    fallbackIndex += 1;
    if (!filled.includes(next)) filled.push(next);
  }

  return filled.slice(0, 4);
}

function chunkIntoPunchyBlocks(script, preferredWords = 3) {
  const words = script
    .replace(/[^\w\s'’-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const blocks = [];
  for (let i = 0; i < words.length; ) {
    const remaining = words.length - i;
    let take = preferredWords;
    if (remaining === 4) take = 2;
    else if (remaining < preferredWords) take = remaining;
    else if (remaining === preferredWords + 1) take = 2;

    blocks.push(words.slice(i, i + take).join(" "));
    i += take;
  }

  return blocks.length > 0 ? blocks : [script.trim()].filter(Boolean);
}

function estimateBlockLength(block, totalWords, totalDuration) {
  const words = block.split(/\s+/).filter(Boolean).length;
  const share = Math.max(words / Math.max(totalWords, 1), 0.04);
  return Math.max(Number((share * totalDuration).toFixed(2)), 0.85);
}

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

function buildShotstackTimeline(script, tone, pexelsVideoUrls, subtitleThemeName) {
  const theme =
    SUBTITLE_THEMES[subtitleThemeName] || SUBTITLE_THEMES["Viral Yellow"];
  const captionBlocks = chunkIntoPunchyBlocks(script, 3);
  const totalDuration = 45;
  const totalWords = captionBlocks.join(" ").split(/\s+/).filter(Boolean).length;

  let cursor = 0;
  const captionClips = captionBlocks.map((block, index) => {
    const length = estimateBlockLength(block, totalWords, totalDuration);
    const clip = {
      asset: {
        type: "rich-text",
        text: block,
        font: {
          family: "Montserrat-ExtraBold",
          size: 52,
          weight: 800,
          color: theme.color,
        },
        style: {
          textTransform: theme.textTransform,
          letterSpacing: theme.letterSpacing,
          lineHeight: 1.05,
          wordSpacing: 2,
        },
        stroke: {
          width: theme.strokeWidth,
          color: theme.strokeColor,
          opacity: 1,
        },
        shadow: {
          offsetX: 0,
          offsetY: 3,
          blur: 0,
          color: "#000000",
          opacity: 0.65,
        },
        align: { horizontal: "center", vertical: "middle" },
        animation: {
          preset: "slideIn",
          direction: index % 2 === 0 ? "left" : "up",
          duration: 0.15,
          style: "word",
        },
      },
      start: Number(cursor.toFixed(2)),
      length,
      width: 680,
      height: 220,
      position: "bottom",
      offset: { x: 0, y: 0.12 },
      transition: { in: "slideLeftFast", out: "fadeFast" },
      effect: "zoomIn",
    };
    cursor += length;
    return clip;
  });

  const videoSources =
    Array.isArray(pexelsVideoUrls) && pexelsVideoUrls.length > 0
      ? pexelsVideoUrls
      : PEXELS_FALLBACK_CLIPS;

  const videoDuration = Math.max(cursor, totalDuration);
  const clipCount = Math.min(4, Math.max(3, videoSources.length));
  const segmentLength = Number((videoDuration / clipCount).toFixed(2));

  const videoClips = videoSources.slice(0, clipCount).map((src, index) => ({
    asset: { type: "video", src, volume: 0 },
    start: Number((index * segmentLength).toFixed(2)),
    length: segmentLength,
    fit: "cover",
    transition: { in: "fade", out: "fade" },
  }));

  const audioClip = {
    asset: {
      type: "text-to-speech",
      text: script,
      voice: TTS_VOICE_BY_TONE[tone] || "Amy",
    },
    start: 0,
    length: "auto",
  };

  return {
    timeline: {
      background: "#09090b",
      fonts: [
        {
          src: "https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/fonts/Montserrat-ExtraBold.ttf",
        },
      ],
      tracks: [
        { clips: captionClips },
        { clips: [audioClip] },
        { clips: videoClips },
      ],
    },
    output: {
      format: "mp4",
      resolution: "hd",
      aspectRatio: "9:16",
      fps: 30,
    },
  };
}

async function submitShotstackRender(edit) {
  const apiKey = process.env.SHOTSTACK_API_KEY;
  if (!apiKey || apiKey === "your_shotstack_key_here") {
    throw new Error("SHOTSTACK_API_KEY is not configured on the server.");
  }

  const response = await fetch(SHOTSTACK_RENDER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(edit),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.success) {
    console.error(
      "Shotstack render error:",
      JSON.stringify(data || response.statusText, null, 2)
    );
    const validationErrors = data?.response?.errors;
    const detail =
      Array.isArray(validationErrors) && validationErrors.length > 0
        ? validationErrors
            .map((err) => err?.message || err?.error || JSON.stringify(err))
            .join("; ")
        : data?.response?.message || data?.message || "Failed to queue Shotstack render.";
    throw new Error(detail);
  }

  return data.response?.id;
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

    const pexelsVideoUrls = await fetchPexelsVerticalClips(topic);
    const script = await draftScript(topic, tone);
    const edit = buildShotstackTimeline(
      script,
      tone,
      pexelsVideoUrls,
      subtitleTheme
    );
    const renderId = await submitShotstackRender(edit);

    if (!renderId) {
      throw new Error("Shotstack did not return a render id.");
    }

    const updatedProfile = await deductCreditIfNeeded(profile);
    const supabase = getSupabaseAdmin();

    const { data: videoRow, error: videoError } = await supabase
      .from("videos")
      .insert({
        user_id: updatedProfile.id,
        clerk_user_id: userId,
        prompt: topic,
        tone,
        subtitle_theme: subtitleTheme,
        script,
        render_id: renderId,
        video_url: null,
        thumbnail_url: null,
        status: "queued",
      })
      .select("id, render_id, prompt, status, created_at")
      .single();

    if (videoError) {
      console.error("Supabase video insert error:", videoError);
      throw new Error("Render queued but failed to save history record.");
    }

    return NextResponse.json({
      renderId,
      videoId: videoRow.id,
      statusUrl: `/api/generate/status?id=${encodeURIComponent(renderId)}`,
      script,
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
