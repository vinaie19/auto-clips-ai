/** Shared render/queue constants (API + worker). */

export const LEASE_SECONDS = 180;
export const MAX_ATTEMPTS_DEFAULT = 3;
export const RENDERS_BUCKET = "renders";

/** OpenAI TTS voices (tts-1). */
export const TTS_VOICES = [
  {
    id: "alloy",
    label: "Alloy",
    description: "Neutral, balanced",
  },
  {
    id: "echo",
    label: "Echo",
    description: "Warm male",
  },
  {
    id: "fable",
    label: "Fable",
    description: "British storyteller",
  },
  {
    id: "onyx",
    label: "Onyx",
    description: "Deep, authoritative",
  },
  {
    id: "nova",
    label: "Nova",
    description: "Bright female",
  },
  {
    id: "shimmer",
    label: "Shimmer",
    description: "Soft, expressive",
  },
];

export const TTS_VOICE_IDS = TTS_VOICES.map((v) => v.id);

/** Video narration tones — script style + default TTS voice. */
export const VIDEO_TONES = {
  Moody: {
    blurb:
      "Intimate and reflective — atmospheric narration with quiet tension, like late-night thoughts.",
    scriptGuide:
      "Write in a moody, atmospheric narrator voice — intimate, reflective, cinematic tension.",
    defaultVoice: "onyx",
  },
  Corporate: {
    blurb:
      "Polished and confident — clear, benefit-led narration that sounds like a sharp brand explainer.",
    scriptGuide:
      "Write in a polished corporate narrator voice — clear, confident, professional, benefit-led.",
    defaultVoice: "alloy",
  },
  Cinematic: {
    blurb:
      "Dramatic and vivid — measured pacing, high stakes, like a trailer voice guiding the scene.",
    scriptGuide:
      "Write in a cinematic, dramatic narrator voice — vivid imagery, measured pacing, high stakes.",
    defaultVoice: "nova",
  },
  Playful: {
    blurb:
      "Light, witty, and conversational — fun energy without trying too hard.",
    scriptGuide:
      "Write in a playful, witty narrator voice — light humor, conversational rhythm, upbeat curiosity.",
    defaultVoice: "shimmer",
  },
  Urgent: {
    blurb:
      "Direct and high-energy — FOMO pacing that pushes you to act now.",
    scriptGuide:
      "Write in an urgent, high-energy narrator voice — short punchy lines, FOMO, direct calls to attention.",
    defaultVoice: "echo",
  },
  Educational: {
    blurb:
      "Clear teacher energy — patient, structured, easy to follow.",
    scriptGuide:
      "Write in an educational narrator voice — clear explanations, helpful framing, calm confident teaching tone.",
    defaultVoice: "alloy",
  },
  Storyteller: {
    blurb:
      "Warm narrative arc — draws you in like someone telling a memorable story.",
    scriptGuide:
      "Write in a warm storyteller narrator voice — narrative hooks, sensory detail, satisfying payoff.",
    defaultVoice: "fable",
  },
  Luxurious: {
    blurb:
      "Slow and premium — refined wording that feels expensive and intentional.",
    scriptGuide:
      "Write in a luxurious, premium narrator voice — refined diction, unhurried pacing, elevated sensory detail.",
    defaultVoice: "onyx",
  },
};

export const VIDEO_TONE_IDS = Object.keys(VIDEO_TONES);

/** @deprecated use VIDEO_TONES[tone].defaultVoice */
export const TTS_VOICE_BY_TONE = Object.fromEntries(
  VIDEO_TONE_IDS.map((id) => [id, VIDEO_TONES[id].defaultVoice])
);

export const VOICE_PREVIEW_LINE =
  "This is how I'll sound narrating your short-form video.";

/** Burned-in caption styles. */
export const SUBTITLE_THEMES = {
  "Viral Yellow": {
    color: "#FFE600",
    strokeColor: "#000000",
    strokeWidth: 5,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    sample: "WAIT FOR IT",
    blurb: "Bold TikTok-style punch captions — loud yellow, heavy black outline.",
  },
  "Cyberpunk Neon": {
    color: "#00F0FF",
    strokeColor: "#FF00AA",
    strokeWidth: 5,
    textTransform: "uppercase",
    letterSpacing: 2,
    sample: "NEON NIGHTS",
    blurb: "Cyan glow with pink outline — futuristic, high-energy look.",
  },
  "Clean Minimalist": {
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 5,
    textTransform: "none",
    letterSpacing: 0.5,
    sample: "Keep it simple",
    blurb: "Soft white type, light outline — calm and readable.",
  },
  "Hot Magenta": {
    color: "#FF2D95",
    strokeColor: "#1A0010",
    strokeWidth: 5,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    sample: "MAIN CHARACTER",
    blurb: "Reels-ready magenta punch — loud, modern, scroll-stopping.",
  },
  "Sunset Orange": {
    color: "#FF8A3D",
    strokeColor: "#2A1000",
    strokeWidth: 5,
    textTransform: "uppercase",
    letterSpacing: 1,
    sample: "GOLDEN HOUR",
    blurb: "Warm orange energy — motivational and vibrant without neon chaos.",
  },
  "Ice Blue": {
    color: "#A8E7FF",
    strokeColor: "#062033",
    strokeWidth: 4,
    textTransform: "none",
    letterSpacing: 0.6,
    sample: "Stay cool",
    blurb: "Cool ice-blue captions — crisp, modern, tech-friendly.",
  },
  "Horror White": {
    color: "#F5F5F5",
    strokeColor: "#5C0000",
    strokeWidth: 4,
    textTransform: "uppercase",
    letterSpacing: 2.5,
    sample: "DON'T LOOK",
    blurb: "Thin pale type with dark-red edge — dread and suspense.",
  },
  "Lime Pop": {
    color: "#C8FF3D",
    strokeColor: "#102000",
    strokeWidth: 5,
    textTransform: "uppercase",
    letterSpacing: 1.4,
    sample: "NO CAP",
    blurb: "Acid lime punch — Gen-Z pop, playful and loud.",
  },
};

export const SUBTITLE_THEME_IDS = Object.keys(SUBTITLE_THEMES);

/** Target clip lengths (seconds) → script word / sentence guidance + credit cost. */
export const VIDEO_DURATIONS = {
  30: {
    seconds: 30,
    label: "30s",
    blurb: "Quick hook — short and punchy.",
    wordRange: "70–90",
    sentenceRange: "4 to 6",
    credits: 2,
  },
  45: {
    seconds: 45,
    label: "45s",
    blurb: "Standard short-form length.",
    wordRange: "110–130",
    sentenceRange: "6 to 10",
    credits: 3,
  },
  60: {
    seconds: 60,
    label: "60s",
    blurb: "Full minute — more room to explain.",
    wordRange: "145–170",
    sentenceRange: "8 to 14",
    credits: 4,
  },
};

export const VIDEO_DURATION_SECONDS = [30, 45, 60];

/**
 * Credits charged for a target duration (30→2, 45→3, 60→4).
 * @param {unknown} seconds
 * @returns {number}
 */
export function creditsForDuration(seconds) {
  const n = Number(seconds);
  const meta = VIDEO_DURATIONS[n];
  if (meta?.credits) return meta.credits;
  return VIDEO_DURATIONS[45].credits;
}
/** Output frame sizes. */
export const ASPECT_RATIOS = {
  "9:16": {
    id: "9:16",
    label: "9:16 Vertical",
    blurb: "TikTok, Reels, Shorts — phone-first.",
    width: 1080,
    height: 1920,
    orientation: "portrait",
  },
  "16:9": {
    id: "16:9",
    label: "16:9 Landscape",
    blurb: "YouTube and widescreen.",
    width: 1920,
    height: 1080,
    orientation: "landscape",
  },
  "1:1": {
    id: "1:1",
    label: "1:1 Square",
    blurb: "Feed posts and carousels.",
    width: 1080,
    height: 1080,
    orientation: "square",
  },
};

export const ASPECT_RATIO_IDS = Object.keys(ASPECT_RATIOS);

/** Visual styles — lowercase-with-spaces canonical ids (Keep in sync with worker/pipeline/prepare/video-taxonomy.js, F11). */
export const VISUAL_STYLES = [
  {
    id: "realistic",
    label: "Realistic",
    blurb: "True-to-life footage — documentary, how-to, everyday moments.",
    previewSrc: "/styles/realistic.jpg?v=2",
  },
  {
    id: "cinematic",
    label: "Cinematic",
    blurb: "Film look — golden hour, shallow depth of field, dramatic framing.",
    previewSrc: "/styles/cinematic.jpg?v=2",
  },
  {
    id: "cartoon",
    label: "Cartoon",
    blurb: "Playful illustrated look — bold shapes, flat color.",
    previewSrc: "/styles/cartoon.jpg?v=2",
  },
  {
    id: "2d animation",
    label: "2D Animation",
    blurb: "Flat vector motion — explainer and infographic energy.",
    previewSrc: "/styles/2d-animation.jpg?v=2",
  },
  {
    id: "3d animation",
    label: "3D Animation",
    blurb: "Rendered 3D worlds and objects.",
    previewSrc: "/styles/3d-animation.jpg?v=2",
  },
  {
    id: "motion graphics",
    label: "Motion Graphics",
    blurb: "Kinetic typography and abstract shapes — best for facts, stats, and explainers.",
    previewSrc: "/styles/motion-graphics.jpg?v=2",
  },
  {
    id: "anime/comic",
    label: "Anime / Comic",
    blurb: "Manga and comic-panel styling.",
    previewSrc: "/styles/anime-comic.jpg?v=2",
  },
  {
    id: "horror/dark",
    label: "Horror / Dark",
    blurb: "Moody, shadowed, dread-forward frames.",
    previewSrc: "/styles/horror-dark.jpg?v=2",
  },
  {
    id: "minimal",
    label: "Minimal",
    blurb: "Clean, sparse compositions — lots of negative space.",
    previewSrc: "/styles/minimal.jpg?v=2",
  },
  {
    id: "vintage",
    label: "Vintage",
    blurb: "Retro film grain and period look.",
    previewSrc: "/styles/vintage.jpg?v=3",
  },
];

export const VISUAL_STYLE_IDS = VISUAL_STYLES.map((s) => s.id);

/**
 * Resolve a posted visual style. Returns the canonical id, null when unset/Auto
 * (route omits the field), or undefined when an unknown non-empty value is
 * posted (route returns 400).
 * @param {unknown} value
 * @returns {string | null | undefined}
 */
export function resolveVisualStyle(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "" || raw.toLowerCase() === "auto") return null;
  const id = raw.toLowerCase();
  if (VISUAL_STYLE_IDS.includes(id)) return id;
  return undefined;
}

/** Auto-derived purpose from narration tone — never a manual picker (D13). */
export const PURPOSE_BY_TONE = {
  Moody: "horror/story recap",
  Corporate: "product promotion",
  Cinematic: "documentary",
  Playful: "social/news",
  Urgent: "motivation",
  Educational: "educational",
  Storyteller: "storytelling",
  Luxurious: "product promotion",
};

/**
 * @param {string} [tone]
 * @returns {string} a D2 purpose value
 */
export function resolvePurpose(tone) {
  return PURPOSE_BY_TONE[tone] || "storytelling";
}

/**
 * @param {unknown} value
 * @returns {30 | 45 | 60}
 */
export function resolveTargetDuration(value) {
  const n = Number(value);
  if (VIDEO_DURATION_SECONDS.includes(n)) return /** @type {30|45|60} */ (n);
  return 45;
}

/**
 * @param {unknown} value
 * @returns {keyof typeof ASPECT_RATIOS}
 */
export function resolveAspectRatio(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (ASPECT_RATIO_IDS.includes(id)) return /** @type {keyof typeof ASPECT_RATIOS} */ (id);
  return "9:16";
}

/**
 * @param {unknown} voice
 * @param {string} [tone]
 * @returns {string}
 */
export function resolveTtsVoice(voice, tone) {
  const id = typeof voice === "string" ? voice.trim().toLowerCase() : "";
  if (TTS_VOICE_IDS.includes(id)) return id;
  return TTS_VOICE_BY_TONE[tone] || TTS_VOICE_BY_TONE.Cinematic;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function resolveCaptionsEnabled(value) {
  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }
  return true;
}

/**
 * @param {number} attempt - attempts count after the failure (1-based for backoff)
 */
export function computeBackoffSeconds(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(180, Math.round(30 * 1.5 ** n));
}

/**
 * Classify whether a render error should auto-retry.
 * @param {unknown} err
 */
export function isRetryableError(err) {
  if (!err) return false;

  const status = Number(err.status ?? err.statusCode ?? err.code);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;

  const msg = String(err.message || err || "").toLowerCase();
  if (!msg) return false;

  const nonRetryable = [
    "invalid payload",
    "empty script",
    "missing env",
    "not configured",
    "ffmpeg is not installed",
    "unauthorized",
    "forbidden",
    "bad request",
  ];
  if (nonRetryable.some((s) => msg.includes(s))) return false;

  const retryable = [
    "timeout",
    "etimedout",
    "econnreset",
    "econnrefused",
    "network",
    "fetch failed",
    "socket",
    "temporarily",
    "rate limit",
    "429",
    "503",
    "502",
    "oom",
    "out of memory",
    "enospc",
    "no space",
  ];
  return retryable.some((s) => msg.includes(s));
}
