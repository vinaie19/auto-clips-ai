import { writeFileSync } from "node:fs";

/** Keep in sync with src/lib/render-constants.js SUBTITLE_THEMES. */
const THEMES = {
  "Viral Yellow": {
    primary: "#FFE600",
    outline: "#000000",
    textTransform: "uppercase",
  },
  "Cyberpunk Neon": {
    primary: "#00F0FF",
    outline: "#FF00AA",
    textTransform: "uppercase",
  },
  "Clean Minimalist": {
    primary: "#FFFFFF",
    outline: "#000000",
    textTransform: "none",
  },
  "Hot Magenta": {
    primary: "#FF2D95",
    outline: "#1A0010",
    textTransform: "uppercase",
  },
  "Sunset Orange": {
    primary: "#FF8A3D",
    outline: "#2A1000",
    textTransform: "uppercase",
  },
  "Ice Blue": {
    primary: "#A8E7FF",
    outline: "#062033",
    textTransform: "none",
  },
  "Horror White": {
    primary: "#F5F5F5",
    outline: "#5C0000",
    textTransform: "uppercase",
  },
  "Lime Pop": {
    primary: "#C8FF3D",
    outline: "#102000",
    textTransform: "uppercase",
  },
};

/** #RRGGBB → ASS &H00BBGGRR */
function hexToAss(hex) {
  const h = String(hex || "#FFFFFF").replace("#", "");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

function formatAssTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Split narration into clauses so captions never glue the end of one action
 * onto the start of the next (e.g. "blended and heat").
 */
export function splitCaptionClauses(script) {
  const text = String(script || "").trim();
  if (!text) return [];

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const clauses = [];
  for (const sentence of sentences) {
    const parts = sentence
      .split(/\s+(?:and|then|but|so|or)\s+|,\s+|;\s+|—\s*|–\s*/i)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) clauses.push(...parts);
    else clauses.push(sentence);
  }

  return clauses.length > 0 ? clauses : [text];
}

/**
 * Punchy caption blocks that respect clause boundaries.
 * Never straddles "…blended and heat…".
 * @param {string} script
 * @param {number} [preferredWords=3]
 */
export function chunkIntoPunchyBlocks(script, preferredWords = 3) {
  const pref = Math.max(2, Math.min(4, Number(preferredWords) || 3));
  const clauses = splitCaptionClauses(script);
  const blocks = [];

  for (const clause of clauses) {
    const words = String(clause)
      .replace(/[^\w\s'’-]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    if (words.length === 0) continue;

    // Short clause → keep as one caption (reads as a phrase).
    if (words.length <= pref + 1) {
      blocks.push(words.join(" "));
      continue;
    }

    for (let i = 0; i < words.length; ) {
      const remaining = words.length - i;
      let take = pref;
      if (remaining <= pref) take = remaining;
      else if (remaining === pref + 1) take = pref - 1; // avoid a 1-word orphan
      else if (remaining === pref + 2) take = Math.ceil(remaining / 2);

      blocks.push(words.slice(i, i + take).join(" "));
      i += take;
    }
  }

  return blocks.length > 0 ? blocks : [String(script).trim()].filter(Boolean);
}

function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

/**
 * Proportional caption windows that always sum to totalDuration.
 * @param {string[]} blocks
 * @param {number} totalDuration
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function computeCaptionTimings(blocks, totalDuration) {
  const duration = Math.max(0.5, Number(totalDuration) || 0);
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (list.length === 0) return [];

  const weights = list.map((block) => {
    const words = String(block).split(/\s+/).filter(Boolean).length;
    return Math.max(1, words);
  });
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

  let cursor = 0;
  return list.map((text, i) => {
    const isLast = i === list.length - 1;
    const share = weights[i] / weightSum;
    const start = cursor;
    const end = isLast
      ? duration
      : Math.min(duration, Number((cursor + share * duration).toFixed(4)));
    cursor = end;
    return { start, end, text: String(text) };
  });
}

/**
 * Write timed ASS captions.
 * @param {string} assPath
 * @param {string[]} blocks
 * @param {number} totalDuration
 * @param {string} themeName
 * @param {{ width?: number, height?: number, timings?: { start: number, end: number, text: string }[] }} [frame]
 */
export function writeAssCaptions(
  assPath,
  blocks,
  totalDuration,
  themeName,
  frame = {}
) {
  const theme = THEMES[themeName] || THEMES["Viral Yellow"];
  const primary = hexToAss(theme.primary);
  const outline = hexToAss(theme.outline);
  const timings =
    Array.isArray(frame.timings) && frame.timings.length > 0
      ? frame.timings
      : computeCaptionTimings(blocks, totalDuration);
  const width = Math.max(16, Math.round(Number(frame.width) || 1080));
  const height = Math.max(16, Math.round(Number(frame.height) || 1920));
  const fontSize = height >= width ? 72 : height === width ? 64 : 68;
  const marginV = Math.round(height * (height >= width ? 0.115 : 0.08));
  const marginX = Math.round(width * 0.04);

  const dialogue = timings.map(({ start, end, text: block }) => {
    if (end <= start + 0.01) return null;
    let text = escapeAssText(block);
    if (theme.textTransform === "uppercase") text = text.toUpperCase();
    return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}`;
  }).filter(Boolean);

  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,${fontSize},${primary},&H000000FF,${outline},&H80000000,-1,0,0,0,100,100,0,0,1,6,0,2,${marginX},${marginX},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogue.join("\n")}
`;

  writeFileSync(assPath, content, "utf8");
  return assPath;
}
