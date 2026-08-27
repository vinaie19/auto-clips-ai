const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

/** Vision model for still-vs-line checks (same family as script/query planning). */
export const CLIP_VERIFY_MODEL = "gpt-4o-mini";

/** Minimum score (0–1) to accept a stock still as matching the spoken line. */
export const CLIP_MATCH_THRESHOLD = 0.6;

/** Minimum styleScore (0–1) for strict visual-style tiers. */
export const STYLE_MATCH_THRESHOLD = 0.5;

const STYLE_LOOK = {
  cartoon: "flat 2D cartoon illustration, not live action",
  "2d animation": "flat vector 2D animation, not photoreal",
  "3d animation": "rendered 3D CGI, not live-action film",
  "motion graphics": "kinetic typography or abstract motion graphics shapes",
  "anime/comic": "anime/manga or comic-panel art, not photoreal",
};

/**
 * Parse vision JSON into a stable verdict.
 * Relevance (`match`) and style (`styleMatch`) are independent axes.
 * @param {string|object} raw
 * @param {{ style?: string | null }} [opts]
 * @returns {{ match: boolean, score: number, reason: string, betterQuery: string | null, styleMatch: boolean | null, styleScore: number | null }}
 */
export function normalizeClipVerdict(raw, opts = {}) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        match: false,
        score: 0.3,
        reason: "unparseable verdict; rejecting clip",
        betterQuery: null,
        styleMatch: null,
        styleScore: null,
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

  const styleRequested = Boolean(opts.style || opts.styleRequested);
  const styleScoreRaw = Number(parsed?.styleScore);
  const styleScore = Number.isFinite(styleScoreRaw)
    ? Math.min(1, Math.max(0, styleScoreRaw))
    : null;
  const styleMatch =
    !styleRequested || styleScore === null
      ? null
      : styleScore >= STYLE_MATCH_THRESHOLD;

  return { match, score, reason, betterQuery, styleMatch, styleScore };
}

/**
 * Ask gpt-4o-mini whether a still matches the spoken line (and optional style).
 * On API failure / missing key, returns match:true so generate is not blocked.
 *
 * @param {{ line: string, query: string, imageUrl: string, style?: string | null }} input
 */
export async function verifyClipAgainstLine(input) {
  const line = String(input?.line || "").trim();
  const query = String(input?.query || "").trim();
  const imageUrl = String(input?.imageUrl || "").trim();
  const style =
    typeof input?.style === "string" && input.style.trim()
      ? input.style.trim().toLowerCase()
      : null;

  if (!imageUrl || (!line && !query)) {
    return {
      match: true,
      score: 0.5,
      reason: "missing line or image; skip verify",
      betterQuery: null,
      styleMatch: null,
      styleScore: null,
    };
  }

  // Allow disabling in tests / emergencies (before key check so stubs don't call OpenAI)
  if (process.env.CLIP_VERIFY === "0" || process.env.CLIP_VERIFY === "false") {
    return {
      match: true,
      score: 1,
      reason: "CLIP_VERIFY disabled",
      betterQuery: null,
      styleMatch: style ? true : null,
      styleScore: style ? 1 : null,
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    return {
      match: true,
      score: 0.5,
      reason: "OPENAI_API_KEY missing; skip verify",
      betterQuery: null,
      styleMatch: style ? true : null,
      styleScore: style ? 1 : null,
    };
  }

  const styleLook = style ? STYLE_LOOK[style] || style : null;
  const stylePrompt = styleLook
    ? `\n- ALSO score styleScore 0–1 on whether the IMAGE looks like "${style}" (${styleLook}). styleScore is independent of subject relevance.`
    : "";
  const styleJson = styleLook
    ? `,
  "styleScore": 0.0`
    : "";

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
- If mismatch, betterQuery: concrete 2–6 word Pexels phrase naming the main action (e.g. "bodyweight push ups floor").${stylePrompt}
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
  "betterQuery": "optional improved pexels query or null"${styleJson}
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
        styleMatch: style ? true : null,
        styleScore: style ? 0.5 : null,
      };
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "{}";
    return normalizeClipVerdict(raw, { style });
  } catch (err) {
    console.warn("clip verify failed:", err?.message || err);
    return {
      match: true,
      score: 0.5,
      reason: "verify exception; accepting clip",
      betterQuery: null,
      styleMatch: style ? true : null,
      styleScore: style ? 0.5 : null,
    };
  }
}
