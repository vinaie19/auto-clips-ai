import { getSupabaseAdmin } from "./supabase-admin";
import {
  LEASE_SECONDS,
  computeBackoffSeconds,
  isRetryableError,
} from "./render-constants";

export { LEASE_SECONDS, computeBackoffSeconds, isRetryableError };

/**
 * Extend lease while a worker is encoding.
 */
export async function heartbeatJob(jobId, workerId, leaseSeconds = LEASE_SECONDS) {
  const supabase = getSupabaseAdmin();
  const nextVisible = new Date(Date.now() + leaseSeconds * 1000).toISOString();

  const { data, error } = await supabase
    .from("videos")
    .update({
      status: "running",
      heartbeat_at: new Date().toISOString(),
      next_visible_at: nextVisible,
      expires_at: nextVisible,
      progress: "rendering",
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("claimed_by", workerId)
    .in("status", ["claimed", "running"])
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("heartbeatJob error:", error);
    throw new Error("Failed to heartbeat render job.");
  }

  return data;
}

/**
 * Mark job done and clear claim fields.
 */
export async function completeJob(jobId, { videoUrl, thumbnailUrl = null } = {}) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("videos")
    .update({
      status: "done",
      video_url: videoUrl,
      thumbnail_url: thumbnailUrl,
      error: null,
      progress: null,
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
      next_visible_at: null,
      expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .in("status", ["claimed", "running"])
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("completeJob error:", error);
    throw new Error("Failed to complete render job.");
  }

  return data;
}

/**
 * Fail or requeue. Terminal fail sets status=failed (caller refunds credit).
 * @returns {{ job: object|null, terminal: boolean }}
 */
export async function failJob(jobId, { error: errMsg, retryable } = {}) {
  const supabase = getSupabaseAdmin();
  const message = String(errMsg || "Render failed").slice(0, 500);

  const { data: current, error: loadError } = await supabase
    .from("videos")
    .select("*")
    .eq("id", jobId)
    .single();

  if (loadError || !current) {
    console.error("failJob load error:", loadError);
    throw new Error("Failed to load render job for failure handling.");
  }

  const nextAttempts = Number(current.attempts || 0) + 1;
  const maxAttempts = Number(current.max_attempts || 3);
  const shouldRetry = Boolean(retryable) && nextAttempts < maxAttempts;

  if (shouldRetry) {
    const backoff = computeBackoffSeconds(nextAttempts);
    const nextVisible = new Date(Date.now() + backoff * 1000).toISOString();

    const { data, error } = await supabase
      .from("videos")
      .update({
        status: "pending",
        attempts: nextAttempts,
        error: message,
        progress: null,
        claimed_by: null,
        claimed_at: null,
        heartbeat_at: null,
        next_visible_at: nextVisible,
        expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .select("*")
      .maybeSingle();

    if (error) {
      console.error("failJob requeue error:", error);
      throw new Error("Failed to requeue render job.");
    }

    return { job: data, terminal: false };
  }

  const { data, error } = await supabase
    .from("videos")
    .update({
      status: "failed",
      attempts: nextAttempts,
      error: message,
      progress: null,
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
      next_visible_at: null,
      expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .in("status", ["claimed", "running", "pending"])
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("failJob terminal error:", error);
    throw new Error("Failed to mark render job failed.");
  }

  return { job: data, terminal: true };
}

/**
 * User manual retry: reset a failed row to pending.
 */
export async function manualRequeue(jobId) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("videos")
    .update({
      status: "pending",
      attempts: 0,
      error: null,
      progress: null,
      video_url: null,
      thumbnail_url: null,
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
      next_visible_at: new Date().toISOString(),
      expires_at: null,
      credit_refunded: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "failed")
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("manualRequeue error:", error);
    throw new Error("Failed to requeue render job.");
  }

  return data;
}

/**
 * Claim via Postgres RPC (SKIP LOCKED).
 */
export async function claimRenderJob(workerId, leaseSeconds = LEASE_SECONDS) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("claim_render_job", {
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });

  if (error) {
    console.error("claim_render_job RPC error:", error);
    throw new Error("Failed to claim render job.");
  }

  // PostgREST: SETOF → array; NULL composite may appear as { id: null }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) return null;
  return row;
}
