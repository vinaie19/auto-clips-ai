export const DEFAULT_VIDEO_PAGE_SIZE = 24;
export const MAX_VIDEO_PAGE_SIZE = 48;

export const VIDEO_LIST_COLUMNS =
  "id, prompt, tone, subtitle_theme, script, video_url, thumbnail_url, status, progress, render_id, error, attempts, created_at, payload";

/**
 * @param {string | null | undefined} raw
 */
export function parseVideoListLimit(raw) {
  if (raw == null || raw === "") return DEFAULT_VIDEO_PAGE_SIZE;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_VIDEO_PAGE_SIZE;
  return Math.min(n, MAX_VIDEO_PAGE_SIZE);
}

/**
 * @param {{ created_at: string, id: string }} row
 */
export function encodeVideoListCursor(row) {
  return Buffer.from(
    JSON.stringify({ created_at: row.created_at, id: row.id }),
    "utf8"
  ).toString("base64url");
}

/**
 * @param {string} raw
 * @returns {{ created_at: string, id: string }}
 */
export function decodeVideoListCursor(raw) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid cursor.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.created_at !== "string" ||
    typeof parsed.id !== "string" ||
    !parsed.created_at ||
    !parsed.id
  ) {
    throw new Error("Invalid cursor.");
  }
  return { created_at: parsed.created_at, id: parsed.id };
}

/**
 * PostgREST filter for keyset pagination on (created_at DESC, id DESC).
 * @param {{ created_at: string, id: string }} cursor
 */
export function videoListCursorFilter(cursor) {
  return `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`;
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapVideoListRow(row) {
  const payload =
    row.payload && typeof row.payload === "object" ? row.payload : {};
  return {
    ...row,
    targetDurationSeconds: payload.targetDurationSeconds ?? null,
    aspectRatio: payload.aspectRatio ?? null,
    visualStyle: payload.visualStyle ?? null,
    styleDegraded: Boolean(payload.styleDegraded),
    styleAcceptanceRate:
      typeof payload.styleAcceptanceRate === "number"
        ? payload.styleAcceptanceRate
        : null,
    payload: undefined,
  };
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {number} limit
 */
export function paginateVideoRows(rows, limit) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    videos: page.map(mapVideoListRow),
    nextCursor:
      hasMore && last ? encodeVideoListCursor(last) : null,
  };
}
