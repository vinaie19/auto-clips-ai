/**
 * Purpose + visual-style taxonomy for B-roll routing.
 * Keep VISUAL_STYLE ids in sync with src/lib/render-constants.js (F11).
 */

/** @type {Readonly<Record<string, string>>} */
export const PURPOSE = Object.freeze({
  EDUCATIONAL: "educational",
  SOCIAL_NEWS: "social/news",
  PRODUCT_PROMOTION: "product promotion",
  STORYTELLING: "storytelling",
  MOTIVATION: "motivation",
  TUTORIAL: "tutorial",
  DOCUMENTARY: "documentary",
  HORROR_STORY_RECAP: "horror/story recap",
});

/** @type {Readonly<Record<string, string>>} */
export const VISUAL_STYLE = Object.freeze({
  REALISTIC: "realistic",
  CINEMATIC: "cinematic",
  CARTOON: "cartoon",
  TWO_D_ANIMATION: "2d animation",
  THREE_D_ANIMATION: "3d animation",
  MOTION_GRAPHICS: "motion graphics",
  ANIME_COMIC: "anime/comic",
  HORROR_DARK: "horror/dark",
  MINIMAL: "minimal",
  VINTAGE: "vintage",
});

/** @type {readonly string[]} */
export const VISUAL_STYLE_IDS = Object.freeze(Object.values(VISUAL_STYLE));

/** @type {readonly string[]} */
export const PURPOSE_IDS = Object.freeze(Object.values(PURPOSE));

/**
 * Purpose → default visual style when payload.visualStyle is absent.
 * @type {Readonly<Record<string, string>>}
 */
export const PURPOSE_STYLE_DEFAULT = Object.freeze({
  [PURPOSE.EDUCATIONAL]: VISUAL_STYLE.REALISTIC,
  [PURPOSE.SOCIAL_NEWS]: VISUAL_STYLE.REALISTIC,
  [PURPOSE.PRODUCT_PROMOTION]: VISUAL_STYLE.CINEMATIC,
  [PURPOSE.STORYTELLING]: VISUAL_STYLE.CINEMATIC,
  [PURPOSE.MOTIVATION]: VISUAL_STYLE.CINEMATIC,
  [PURPOSE.TUTORIAL]: VISUAL_STYLE.REALISTIC,
  [PURPOSE.DOCUMENTARY]: VISUAL_STYLE.CINEMATIC,
  [PURPOSE.HORROR_STORY_RECAP]: VISUAL_STYLE.HORROR_DARK,
});

/**
 * Style → stock-query vocabulary injected into query planning.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const STYLE_QUERY_VOCAB = Object.freeze({
  [VISUAL_STYLE.REALISTIC]: Object.freeze([
    "realistic",
    "documentary footage",
    "natural light",
  ]),
  [VISUAL_STYLE.CINEMATIC]: Object.freeze([
    "cinematic",
    "film",
    "golden hour",
    "shallow depth of field",
  ]),
  [VISUAL_STYLE.CARTOON]: Object.freeze([
    "cartoon",
    "animated",
    "illustration",
  ]),
  [VISUAL_STYLE.TWO_D_ANIMATION]: Object.freeze([
    "2d animation",
    "flat illustration",
    "vector",
  ]),
  [VISUAL_STYLE.THREE_D_ANIMATION]: Object.freeze([
    "3d animation",
    "cgi",
    "rendered 3d",
  ]),
  [VISUAL_STYLE.MOTION_GRAPHICS]: Object.freeze([
    "motion graphics",
    "kinetic typography",
    "abstract shapes",
    "animated text",
    "icon animation",
  ]),
  [VISUAL_STYLE.ANIME_COMIC]: Object.freeze([
    "anime",
    "manga",
    "comic style",
  ]),
  [VISUAL_STYLE.HORROR_DARK]: Object.freeze([
    "dark",
    "horror",
    "moody",
    "shadow",
  ]),
  [VISUAL_STYLE.MINIMAL]: Object.freeze([
    "minimal",
    "clean composition",
    "negative space",
  ]),
  [VISUAL_STYLE.VINTAGE]: Object.freeze([
    "vintage",
    "retro film",
    "film grain",
  ]),
});

/** Animated / strict-style tier — Pixabay animation first. */
export const STRICT_STYLE_IDS = Object.freeze([
  VISUAL_STYLE.CARTOON,
  VISUAL_STYLE.TWO_D_ANIMATION,
  VISUAL_STYLE.THREE_D_ANIMATION,
  VISUAL_STYLE.MOTION_GRAPHICS,
  VISUAL_STYLE.ANIME_COMIC,
]);

/**
 * Canonical visual style id, or null when absent/unknown (do NOT default to realistic).
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeVisualStyle(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") return null;
  const id = input.trim().toLowerCase();
  if (!id || id === "auto") return null;
  return VISUAL_STYLE_IDS.includes(id) ? id : null;
}

/**
 * Canonical purpose id; defaults to storytelling when absent/unknown.
 * @param {unknown} input
 * @returns {string}
 */
export function normalizePurpose(input) {
  if (typeof input !== "string") return PURPOSE.STORYTELLING;
  const id = input.trim().toLowerCase();
  if (!id) return PURPOSE.STORYTELLING;
  return PURPOSE_IDS.includes(id) ? id : PURPOSE.STORYTELLING;
}

/**
 * @param {string | null | undefined} visualStyle
 * @returns {boolean}
 */
export function isStrictStyleTier(visualStyle) {
  return Boolean(visualStyle && STRICT_STYLE_IDS.includes(visualStyle));
}
