import { auth } from "@clerk/nextjs/server";
import {
  resolveTtsVoice,
  TTS_VOICE_IDS,
  VOICE_PREVIEW_LINE,
} from "@/lib/render-constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";

/**
 * POST { voice } → audio/mpeg sample for UI preview.
 */
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json().catch(() => ({}));
    const voice = resolveTtsVoice(body?.voice);
    if (!TTS_VOICE_IDS.includes(voice)) {
      return new Response(JSON.stringify({ error: "Invalid voice." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === "your_openai_key_here") {
      return new Response(
        JSON.stringify({ error: "OPENAI_API_KEY is not configured." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const response = await fetch(OPENAI_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice,
        input: VOICE_PREVIEW_LINE,
        response_format: "mp3",
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Voice preview TTS error:", detail.slice(0, 300));
      return new Response(
        JSON.stringify({ error: "Failed to generate voice preview." }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const audio = await response.arrayBuffer();
    return new Response(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("POST /api/voice-preview failed:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Voice preview failed." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
