import { writeFileSync } from "node:fs";

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

export function chunkIntoPunchyBlocks(script, preferredWords = 3) {
  const words = String(script)
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

  return blocks.length > 0 ? blocks : [String(script).trim()].filter(Boolean);
}

function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

/**
 * Write timed ASS captions for vertical video (1080x1920).
 */
export function writeAssCaptions(assPath, blocks, totalDuration, themeName) {
  const theme = THEMES[themeName] || THEMES["Viral Yellow"];
  const primary = hexToAss(theme.primary);
  const outline = hexToAss(theme.outline);
  const totalWords = blocks.join(" ").split(/\s+/).filter(Boolean).length || 1;

  let cursor = 0;
  const dialogue = blocks.map((block) => {
    const words = block.split(/\s+/).filter(Boolean).length;
    const share = Math.max(words / totalWords, 0.04);
    const length = Math.max(share * totalDuration, 0.85);
    const start = cursor;
    const end = Math.min(cursor + length, totalDuration);
    cursor = end;

    let text = escapeAssText(block);
    if (theme.textTransform === "uppercase") text = text.toUpperCase();

    return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${text}`;
  });

  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,72,${primary},&H000000FF,${outline},&H80000000,-1,0,0,0,100,100,0,0,1,6,0,2,40,40,220,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogue.join("\n")}
`;

  writeFileSync(assPath, content, "utf8");
  return assPath;
}
