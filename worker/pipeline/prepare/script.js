/** Script drafting (moved from Next /api/generate onto the worker). */

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

/** Subset of src/lib/render-constants VIDEO_TONES / VIDEO_DURATIONS for prompts. */
const VIDEO_TONES = {
  Moody: {
    scriptGuide:
      "Write in a moody, atmospheric narrator voice — intimate, reflective, cinematic tension.",
  },
  Corporate: {
    scriptGuide:
      "Write in a polished corporate narrator voice — clear, confident, professional, benefit-led.",
  },
  Cinematic: {
    scriptGuide:
      "Write in a cinematic, dramatic narrator voice — vivid imagery, measured pacing, high stakes.",
  },
  Playful: {
    scriptGuide:
      "Write in a playful, witty narrator voice — light humor, conversational rhythm, upbeat curiosity.",
  },
  Urgent: {
    scriptGuide:
      "Write in an urgent, high-energy narrator voice — short punchy lines, FOMO, direct calls to attention.",
  },
  Educational: {
    scriptGuide:
      "Write in an educational narrator voice — clear explanations, helpful framing, calm confident teaching tone.",
  },
  Storyteller: {
    scriptGuide:
      "Write in a warm storyteller narrator voice — narrative hooks, sensory detail, satisfying payoff.",
  },
  Luxurious: {
    scriptGuide:
      "Write in a luxurious, premium narrator voice — refined diction, unhurried pacing, elevated sensory detail.",
  },
};

const VIDEO_DURATIONS = {
  30: { seconds: 30, wordRange: "70–90", sentenceRange: "4 to 6" },
  45: { seconds: 45, wordRange: "110–130", sentenceRange: "6 to 10" },
  60: { seconds: 60, wordRange: "145–170", sentenceRange: "8 to 14" },
};

/**
 * @param {string} topic
 * @param {string} tone
 * @param {number} targetDurationSeconds
 */
export async function draftScript(topic, tone, targetDurationSeconds) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    const err = new Error("OPENAI_API_KEY is not configured on the worker.");
    err.status = 500;
    throw err;
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
    console.error("OpenAI script error:", detail.slice(0, 400));
    const err = new Error("Failed to draft script with OpenAI.");
    err.status = 502;
    throw err;
  }

  const data = await response.json();
  const script = data?.choices?.[0]?.message?.content?.trim();
  if (!script) {
    const err = new Error("OpenAI returned an empty script.");
    err.status = 502;
    throw err;
  }

  return script.replace(/^```[\s\S]*?```$/g, "").trim();
}
