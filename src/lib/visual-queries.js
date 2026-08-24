const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Ask the model for short stock-footage search queries aligned to the script.
 * @param {string} script
 * @param {string} topic
 * @returns {Promise<string[]>}
 */
export async function deriveVisualQueries(script, topic) {
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
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You plan B-roll for short vertical videos. Given a narration script, output concrete stock-footage search queries (what the camera should show). Queries must be visual, specific, and searchable on a stock site (e.g. 'close up coffee pour', 'sunrise city skyline', 'hands typing on laptop'). Avoid abstract words like 'success', 'innovation', 'motivation'. Return JSON only.",
        },
        {
          role: "user",
          content: `Topic: ${topic}

Script:
${script}

Return JSON shaped as:
{"queries":["query1","query2",...]}

Rules:
- 6 to 10 queries
- Each query 2–6 words
- Order follows the script from start to end
- Each query should match a distinct visual beat in the narration
- No duplicates`,
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
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Failed to parse visual B-roll queries.");
  }

  const queries = Array.isArray(parsed?.queries)
    ? parsed.queries.map((q) => String(q || "").trim()).filter(Boolean)
    : [];

  const unique = [];
  const seen = new Set();
  for (const q of queries) {
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(q);
  }

  if (unique.length < 3) {
    // Soft fallback: sentence-ish chunks from topic + script nouns
    unique.push(topic, `${topic} lifestyle`, `${topic} close up`);
  }

  return unique.slice(0, 10);
}
