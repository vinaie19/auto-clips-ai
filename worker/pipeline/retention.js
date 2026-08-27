/** How long a render's files live before deletion (matches the R2 rule). */
export const RETENTION_DAYS = 14;

/**
 * ISO timestamp that separates "kept" from "expired"; rows created before it
 * are past retention. Object deletion itself is done by the R2 lifecycle
 * rule; this only keeps the DB + UI consistent (no dead video links).
 */
export function retentionCutoff(now = new Date(), days = RETENTION_DAYS) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Null out URLs and mark done rows as expired once they pass retention.
 * Idempotent: after the update `status='expired'` and `video_url` is NULL, so
 * rows are never matched twice. Safe to run concurrently across workers.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function sweepExpiredVideos(supabase, now = new Date()) {
  const { error } = await supabase
    .from("videos")
    .update({
      status: "expired",
      video_url: null,
      thumbnail_url: null,
      updated_at: new Date().toISOString(),
    })
    .eq("status", "done")
    .not("video_url", "is", null)
    .lt("created_at", retentionCutoff(now));
  if (error) throw error;
}
