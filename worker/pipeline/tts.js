import { writeFile } from "node:fs/promises";

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";

/**
 * @param {string} text
 * @param {string} voice - OpenAI voice id
 * @param {string} outPath - .mp3 path
 */
export async function synthesizeSpeech(text, voice, outPath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_openai_key_here") {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.status = 500;
    throw err;
  }

  const response = await fetch(OPENAI_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      voice: voice || "nova",
      input: text.slice(0, 4096),
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    const err = new Error(`TTS failed: ${detail.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const buf = Buffer.from(await response.arrayBuffer());
  await writeFile(outPath, buf);
}
