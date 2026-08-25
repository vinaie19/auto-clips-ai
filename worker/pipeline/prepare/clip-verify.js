const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

/** Vision model for still-vs-line checks (same family as script/query planning). */
export const CLIP_VERIFY_MODEL = "gpt-4o-mini";

/** Minimum score (0–1) to accept a Pexels still as matching the spoken line. */
export const CLIP_MATCH_THRESHOLD = 0.6;

/**
 * Parse vision JSON into a stable verdict.
 * @param {string|object} raw
 * @returns {{ match: boolean, score: number, reason: string, betterQuery: string | null }}
 */
export function normalizeClipVerdict(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Treat as mismatch so caller can retry another clip / query.
      return {
        match: false,
        score: 0.3,
        reason: "unparseable verdict; rejecting clip",
        betterQuery: null,
      };
    }
  }

  const scoreRaw = Number(parsed?.score);
  const score = Number.isFinite(scoreRaw)
    ? Math.min(1, Math.max(0, scoreRaw))
    : parsed?.match === false
      ? 0.2
      : 0.7;

  const betterQuery =
    typeof parsed?.betterQuery === "string" && parsed.betterQuery.trim()
      ? parsed.betterQuery.trim().slice(0, 80)
      : null;

  const reason =
    typeof parsed?.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim().slice(0, 240)
      : "";

  const match =
    typeof parsed?.match === "boolean"
      ? parsed.match && score >= CLIP_MATCH_THRESHOLD
      : score >= CLIP_MATCH_THRESHOLD;

  return { match, score, reason, betterQuery };
}

/**
 * Ask gpt-4o-mini whether a still matches the spoken line.
 * On API failure / missing key, returns match:true so generate is not blocked.
 *
 * @param {{ line: string, query: string, imageUrl: string }} input
 */
export async function verifyClipAgainstLine(input) {
  const line = String(input?.line || "").trim();
  const query = String(input?.query || "").trim();
  const imageUrl = String(input?.imageUrl || "").trim();

  if (!imageUrl || (!line && !query)) {
    return {
      match: true,
      score: 0.5,
      reason: "missing line or image; skip verify",
      betterQuery: null,
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    return {
      match: true,
      score: 0.5,
      reason: "OPENAI_API_KEY missing; skip verify",
      betterQuery: null,
    };
  }

  // Allow disabling in tests / emergencies
  if (process.env.CLIP_VERIFY === "0" || process.env.CLIP_VERIFY === "false") {
    return {
      match: true,
      score: 1,
      reason: "CLIP_VERIFY disabled",
      betterQuery: null,
    };
  }

  try {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CLIP_VERIFY_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You judge whether a stock-video thumbnail is good enough B-roll for a spoken line.

Be pragmatic (stills cannot show duration, "continuous motion", or perfect form cues):
- Score 0–1 on whether the IMAGE shows the SAME primary action/subject as the LINE.
- match=true if score >= ${CLIP_MATCH_THRESHOLD} and the main exercise/object/setting is right.
- ACCEPT: same exercise (push-ups, squats, jumping jacks) even if outdoor vs home, or imperfect form.
- ACCEPT: related workout activity when the line is about heart rate / energy / one minute / keep going.
- REJECT only clear mismatches: wrong sport, gym machines when line needs bodyweight-only, totally unrelated objects.
- Do NOT reject just because the still cannot prove "one minute", "knees behind toes", or "continuous".
- If mismatch, betterQuery: concrete 2–6 word Pexels phrase naming the main action (e.g. "bodyweight push ups floor").
Return JSON only.`,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Spoken line: ${line || "(none)"}
Search query used: ${query || "(none)"}

Return JSON:
{
  "match": true,
  "score": 0.0,
  "reason": "short why",
  "betterQuery": "optional improved pexels query or null"
}`,
              },
              {
                type: "image_url",
                image_url: { url: imageUrl, detail: "low" },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.warn("clip verify OpenAI error:", detail.slice(0, 200));
      return {
        match: true,
        score: 0.5,
        reason: "verify API error; accepting clip",
        betterQuery: null,
      };
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "{}";
    return normalizeClipVerdict(raw);
  } catch (err) {
    console.warn("clip verify failed:", err?.message || err);
    return {
      match: true,
      score: 0.5,
      reason: "verify exception; accepting clip",
      betterQuery: null,
    };
  }
}
