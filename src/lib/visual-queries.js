const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

export const MIN_SHOTS = 3;
export const MAX_SHOTS = 5;

/**
 * Plan a continuity-first B-roll shot list for a script.
 * One visual motif, 3–5 angle variations — not 8–10 unrelated subjects.
 *
 * @param {string} script
 * @param {string} topic
 * @returns {Promise<{ motif: string, queries: string[], weights: number[], avoid: string[] }>}
 */
export async function planVisualBeats(script, topic) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }

  const response = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You plan B-roll for short vertical videos. Continuity beats variety.

Rules:
- Pick ONE visual motif (subject + setting + mood) that can carry the whole narration.
- Output 3 to 5 shots that are angles/details of THAT SAME motif — not a new subject each cut.
- Prefer objects, hands, environments, process shots. Avoid random faces/portraits unless the script is explicitly about a person.
- Queries must be concrete stock-search phrases (2–6 words), e.g. "close up coffee pour", "steam rising mug".
- Never use abstract words: success, innovation, motivation, mindset, growth.
- weight is relative hold time (higher = longer on screen). Sum does not need to be 1.
Return JSON only.`,
        },
        {
          role: "user",
          content: `Topic: ${topic}

Script:
${script}

Return JSON shaped as:
{
  "motif": "short phrase naming the single visual world",
  "shots": [
    {"query": "stock search phrase", "weight": 1.2},
    {"query": "related angle of same motif", "weight": 1.0}
  ],
  "avoid": ["things that would break continuity"]
}

Rules:
- 3 to 5 shots only
- Every shot must clearly belong to the motif
- Order follows the script start → end
- No duplicate queries`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Visual query OpenAI error:", detail);
    throw new Error("Failed to derive visual B-roll queries.");
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content?.trim() || "{}";
  return normalizeVisualPlan(raw, topic);
}

/**
 * Normalize LLM JSON into a stable plan shape.
 * @param {string|object} raw
 * @param {string} topic
 */
export function normalizeVisualPlan(raw, topic = "topic") {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Failed to parse visual B-roll queries.");
    }
  }

  const motif =
    typeof parsed?.motif === "string" && parsed.motif.trim()
      ? parsed.motif.trim()
      : String(topic || "topic").trim() || "lifestyle detail";

  const avoid = Array.isArray(parsed?.avoid)
    ? parsed.avoid.map((a) => String(a || "").trim()).filter(Boolean)
    : [];

  /** @type {{ query: string, weight: number }[]} */
  let shots = [];

  if (Array.isArray(parsed?.shots)) {
    for (const s of parsed.shots) {
      const query = String(s?.query || "").trim();
      if (!query) continue;
      const weight = Number(s?.weight);
      shots.push({
        query,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      });
    }
  } else if (Array.isArray(parsed?.queries)) {
    // Legacy shape
    for (const q of parsed.queries) {
      const query = String(q || "").trim();
      if (!query) continue;
      shots.push({ query, weight: 1 });
    }
  }

  // Dedupe by lowercase query, keep first
  const unique = [];
  const seen = new Set();
  for (const shot of shots) {
    const key = shot.query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(shot);
  }

  if (unique.length < MIN_SHOTS) {
    const base = motif.split(/\s+/).slice(0, 3).join(" ") || topic;
    const fillers = [
      `${base} close up`,
      `${base} detail`,
      `${base} wide shot`,
      `hands with ${base}`,
      `${base} atmosphere`,
    ];
    for (const q of fillers) {
      if (unique.length >= MIN_SHOTS) break;
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ query: q, weight: 1 });
    }
  }

  const capped = unique.slice(0, MAX_SHOTS);

  return {
    motif,
    queries: capped.map((s) => s.query),
    weights: capped.map((s) => s.weight),
    avoid,
  };
}

/**
 * @deprecated Prefer planVisualBeats — kept for callers that only need query strings.
 */
export async function deriveVisualQueries(script, topic) {
  const plan = await planVisualBeats(script, topic);
  return plan.queries;
}
