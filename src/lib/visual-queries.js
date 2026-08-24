const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

export const MIN_SHOTS = 4;
/** Enough cuts for a full 60s VO without merging many lines into one beat. */
export const MAX_SHOTS = 15;

/** Vague / filler Pexels phrases that rarely return line-faithful stock. */
const ABSTRACT_WORD_RE =
  /\b(intensity|atmosphere|vibes?|motivation|mindset|energy|lifestyle|success|innovation|growth)\b/i;
const FILLER_TAIL_RE =
  /\s+(close\s*up|detail|wide\s*shot|side\s*angle|overhead|process|atmosphere)$/i;
const ACTIONISH_RE =
  /\b(pour|type|typing|push|push-?ups?|stretch|run|cook|write|hold|lift|sit|stand|walk|cut|mix|open|drink|eat|jump|lunge|squat|plank|sweat|breathe|whisk|heat|stir|chop|fold|press|clap|wave|kick|jog|meditat|yoga|mat|floor|desk|keyboard|mug|cup|coffee|laptop)\b/i;

/**
 * True when a stock query is too vague for reliable Pexels hits.
 * @param {string} query
 */
export function isVagueStockQuery(query) {
  const q = String(query || "").trim();
  if (!q) return true;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.length === 1) {
    return (
      ABSTRACT_WORD_RE.test(q) ||
      /^(close\s*up|detail|wide\s*shot|intensity|atmosphere|vibes?)$/i.test(q)
    );
  }
  if (
    /^(close\s*up|detail|wide\s*shot|side\s*angle|overhead|process|atmosphere|intensity)$/i.test(
      q
    )
  ) {
    return true;
  }
  if (
    /^(intense|epic|motivational|powerful|amazing)\s+(workout|fitness|training|energy)(\s+close\s*up)?$/i.test(
      q
    )
  ) {
    return true;
  }
  if (ABSTRACT_WORD_RE.test(q) && words.length <= 5) return true;
  if (/^(person|people|man|woman)\s+(working\s+out|exercising|training)$/i.test(q)) {
    return true;
  }
  if (FILLER_TAIL_RE.test(q)) {
    const head = q.replace(FILLER_TAIL_RE, "").trim();
    if (!ACTIONISH_RE.test(head) && head.split(/\s+/).length <= 3) return true;
  }
  return false;
}

/**
 * Rewrite a vague query from the spoken line (and topic constraints).
 * @param {string} query
 * @param {string} line
 * @param {string} [topic]
 */
export function hardenStockQuery(query, line, topic = "") {
  const q = String(query || "").trim();
  if (!isVagueStockQuery(q)) return q;

  const spoken = String(line || "").trim();
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "for",
    "with",
    "from",
    "into",
    "your",
    "you",
    "our",
    "this",
    "that",
    "these",
    "those",
    "will",
    "can",
    "just",
    "about",
    "then",
    "than",
    "when",
    "while",
    "have",
    "has",
    "are",
    "is",
    "be",
    "to",
    "of",
    "in",
    "on",
    "at",
    "it",
    "we",
    "they",
    "minute",
    "minutes",
    "second",
    "seconds",
  ]);
  const tokens = spoken
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !stop.has(w.toLowerCase()));

  if (tokens.length >= 2) {
    return tokens.slice(0, 5).join(" ").toLowerCase();
  }

  const topicBits = String(topic || "")
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 4)
    .join(" ");
  return topicBits || q;
}

/**
 * Split narration into spoken lines (sentence beats).
 * @param {string} script
 * @returns {string[]}
 */
export function splitScriptLines(script) {
  const text = String(script || "").trim();
  if (!text) return [];
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

export function wordCount(text) {
  return Math.max(
    1,
    String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length
  );
}

/**
 * Clamp script lines to MIN–MAX beats for B-roll binding.
 * Extra lines merge into the last beat; short scripts split on commas / and / then.
 * @param {string} script
 * @returns {string[]}
 */
export function beatLinesFromScript(script) {
  let lines = splitScriptLines(script);

  if (lines.length > MAX_SHOTS) {
    const head = lines.slice(0, MAX_SHOTS - 1);
    const tail = lines.slice(MAX_SHOTS - 1).join(" ");
    lines = [...head, tail];
  }

  if (lines.length < MIN_SHOTS) {
    const expanded = [];
    for (const line of lines) {
      if (expanded.length >= MAX_SHOTS) {
        expanded.push(line);
        continue;
      }
      const chunks = String(line)
        .split(/\s+(?:and|then|but|so)\s+|,\s+|;\s+|—\s*|–\s*/i)
        .map((s) => s.trim())
        .filter(Boolean);
      if (chunks.length > 1) expanded.push(...chunks);
      else expanded.push(line);
    }
    lines = expanded;
  }

  if (lines.length > MAX_SHOTS) {
    const head = lines.slice(0, MAX_SHOTS - 1);
    const tail = lines.slice(MAX_SHOTS - 1).join(" ");
    lines = [...head, tail];
  }

  while (lines.length < MIN_SHOTS && lines.length > 0) {
    lines.push(lines[lines.length - 1]);
  }

  return lines.slice(0, MAX_SHOTS);
}

/**
 * Plan B-roll with one stock query per spoken script line.
 *
 * @param {string} script
 * @param {string} topic
 * @returns {Promise<{
 *   motif: string,
 *   queries: string[],
 *   weights: number[],
 *   lines: string[],
 *   beats: { line: string, query: string, weight: number }[],
 *   avoid: string[]
 * }>}
 */
export async function planVisualBeats(script, topic) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }

  const lines = beatLinesFromScript(script);
  const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");

  const response = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.25,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You bind B-roll to narration. One stock-video search query per script line.

Rules:
- You receive N numbered lines. Return exactly N shots in the same order.
- Each shot.query must depict WHAT THAT LINE IS SAYING (objects, hands, places, actions a camera can film).
- Queries: concrete Pexels phrases, 2–6 words (e.g. "close up coffee pour", "bodyweight push ups floor").
- Honor TOPIC constraints literally (e.g. "no equipment" → bodyweight / living room — never gym machines or dumbbells; "home" → indoor home setting).
- Ban vague filler: intensity, atmosphere, vibes, motivation, mindset, "intense workout close up", "person working out", lone "close up"/"detail"/"wide shot".
- Motif is secondary: same visual world is good, but NEVER sacrifice line meaning for motif continuity.
- Avoid random faces/portraits unless the line is explicitly about a person.
- Keep each query specific to that line — no repeated vague fillers.
Return JSON only.`,
        },
        {
          role: "user",
          content: `Topic: ${topic}

Script lines (assign one query each, same order):
${numbered}

Return JSON:
{
  "motif": "short phrase for the overall visual world",
  "shots": [
    {"lineIndex": 1, "query": "stock search for line 1"},
    {"lineIndex": 2, "query": "stock search for line 2"}
  ],
  "avoid": ["off-topic stock that would break the story"]
}

Requirements:
- shots.length must equal ${lines.length}
- lineIndex is 1-based and matches the list above
- No duplicate queries unless two lines truly need the same image
- Every query must be filmable and line-specific; respect topic constraints`,
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
  return normalizeVisualPlan(raw, topic, { lines });
}

/**
 * Normalize LLM JSON into line-bound beats.
 * @param {string|object} raw
 * @param {string} topic
 * @param {{ lines?: string[] }} [opts]
 */
export function normalizeVisualPlan(raw, topic = "topic", opts = {}) {
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

  const providedLines = Array.isArray(opts.lines)
    ? opts.lines.map((l) => String(l || "").trim()).filter(Boolean)
    : [];

  /** @type {{ line: string, query: string, weight: number }[]} */
  let beats = [];

  if (Array.isArray(parsed?.shots) && parsed.shots.length > 0) {
    for (let i = 0; i < parsed.shots.length; i++) {
      const s = parsed.shots[i];
      const query = String(s?.query || "").trim();
      if (!query) continue;

      const idx =
        Number.isFinite(Number(s?.lineIndex)) && Number(s.lineIndex) >= 1
          ? Math.floor(Number(s.lineIndex)) - 1
          : i;

      const line =
        (typeof s?.line === "string" && s.line.trim()) ||
        providedLines[idx] ||
        providedLines[i] ||
        query;

      const explicitWeight = Number(s?.weight);
      const weight =
        Number.isFinite(explicitWeight) && explicitWeight > 0
          ? explicitWeight
          : wordCount(line);

      beats.push({ line, query, weight });
    }
  } else if (Array.isArray(parsed?.queries)) {
    for (let i = 0; i < parsed.queries.length; i++) {
      const query = String(parsed.queries[i] || "").trim();
      if (!query) continue;
      const line = providedLines[i] || query;
      beats.push({ line, query, weight: wordCount(line) });
    }
  }

  // Align 1:1 to spoken lines when provided (authoritative beat list).
  if (providedLines.length > 0) {
    beats = providedLines.map((line, i) => {
      const match = beats[i];
      const base = motif.split(/\s+/).slice(0, 3).join(" ") || topic;
      const fallbackQuery =
        i === 0
          ? `${base} wide shot`
          : i === providedLines.length - 1
            ? `${base} detail`
            : `${base} close up`;
      const rawQuery = match?.query || fallbackQuery;
      const query = hardenStockQuery(rawQuery, line, topic);
      return {
        line,
        query,
        weight: wordCount(line),
      };
    });
  } else {
    beats = beats.map((b) => ({
      ...b,
      query: hardenStockQuery(b.query, b.line, topic),
    }));
  }

  // Without authoritative lines, drop duplicate queries (legacy behavior).
  if (providedLines.length === 0) {
    const unique = [];
    const seenQ = new Set();
    for (const b of beats) {
      const key = b.query.toLowerCase();
      if (seenQ.has(key)) continue;
      seenQ.add(key);
      unique.push(b);
    }
    beats = unique;
  }
  if (beats.length < MIN_SHOTS && providedLines.length === 0) {
    const base = motif.split(/\s+/).slice(0, 3).join(" ") || topic;
    const fillers = [
      `${base} close up`,
      `${base} detail`,
      `${base} wide shot`,
      `hands with ${base}`,
      `${base} atmosphere`,
      `${base} process`,
      `${base} overhead`,
      `${base} side angle`,
    ];
    let fi = 0;
    while (beats.length < MIN_SHOTS && fi < fillers.length) {
      const raw = fillers[fi++];
      const line = beats[beats.length - 1]?.line || base;
      const query = hardenStockQuery(raw, line, topic);
      beats.push({ line, query, weight: wordCount(line) });
    }
  }

  const capped = beats.slice(0, MAX_SHOTS);

  return {
    motif,
    queries: capped.map((b) => b.query),
    weights: capped.map((b) => b.weight),
    lines: capped.map((b) => b.line),
    beats: capped,
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
