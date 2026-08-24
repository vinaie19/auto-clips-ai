import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRenderPipeline } from "./pipeline/index.js";

const WORKER_DIR = dirname(fileURLToPath(import.meta.url));

/** Load .env files into process.env (Node does not do this automatically). */
function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined && value !== "") {
      process.env[key] = value;
    }
  }
}

loadEnvFile(join(WORKER_DIR, ".env"));
// Local convenience: OPENAI_API_KEY from repo .env.local if missing
loadEnvFile(join(WORKER_DIR, "..", ".env.local"));

const LEASE_SECONDS = Number(process.env.LEASE_SECONDS || 600);
const POLL_MS = Number(process.env.POLL_MS || 3000);
const WORKER_ID = process.env.WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;
/** Stub only when explicitly STUB_RENDER=1 */
const STUB_RENDER = process.env.STUB_RENDER === "1";
const RENDERS_BUCKET = process.env.RENDERS_BUCKET || "renders";

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in worker/.env or the environment)"
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableError(err) {
  const status = Number(err?.status ?? err?.statusCode ?? err?.code);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(err?.message || err || "").toLowerCase();
  const nonRetryable = [
    "invalid payload",
    "empty script",
    "not configured",
    "ffmpeg is not installed",
  ];
  if (nonRetryable.some((s) => msg.includes(s))) return false;
  const retryable = [
    "timeout",
    "etimedout",
    "econnreset",
    "network",
    "fetch failed",
    "rate limit",
    "oom",
  ];
  return retryable.some((s) => msg.includes(s));
}

function computeBackoffSeconds(attempt) {
  return Math.min(180, Math.round(30 * 1.5 ** Math.max(0, Number(attempt) || 0)));
}

async function claimJob(supabase) {
  const { data, error } = await supabase.rpc("claim_render_job", {
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw error;
  // SETOF → array; legacy NULL composite → { id: null, ... }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) return null;
  return row;
}

async function heartbeat(supabase, jobId) {
  const nextVisible = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
  const { error } = await supabase
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
    .eq("claimed_by", WORKER_ID);
  if (error) throw error;
}

async function completeJob(supabase, jobId, { videoUrl, thumbnailUrl = null }) {
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
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function failJob(supabase, job, err) {
  const message = String(err?.message || err || "Render failed").slice(0, 500);
  const retryable = isRetryableError(err);
  const nextAttempts = Number(job.attempts || 0) + 1;
  const maxAttempts = Number(job.max_attempts || 3);
  const shouldRetry = retryable && nextAttempts < maxAttempts;

  if (shouldRetry) {
    const backoff = computeBackoffSeconds(nextAttempts);
    const nextVisible = new Date(Date.now() + backoff * 1000).toISOString();
    const { error } = await supabase
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
      .eq("id", job.id);
    if (error) throw error;
    console.warn(
      JSON.stringify({
        event: "job_requeued",
        video_id: job.id,
        attempt: nextAttempts,
        backoff_s: backoff,
        error: message,
      })
    );
    return { terminal: false };
  }

  const { data: failed, error } = await supabase
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
    .eq("id", job.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;

  await refundIfNeeded(supabase, failed || { ...job, status: "failed" });
  console.error(
    JSON.stringify({
      event: "job_failed",
      video_id: job.id,
      attempt: nextAttempts,
      error: message,
    })
  );
  return { terminal: true };
}

async function refundIfNeeded(supabase, video) {
  if (!video?.id || video.credit_refunded) return;

  const { data: marked, error: markError } = await supabase
    .from("videos")
    .update({
      credit_refunded: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", video.id)
    .eq("credit_refunded", false)
    .eq("status", "failed")
    .select("id, user_id, credits_charged")
    .maybeSingle();

  if (markError) throw markError;
  if (!marked) return;

  const { error } = await supabase.rpc("refund_free_credit", {
    p_user_id: marked.user_id,
    p_amount: Math.max(1, Math.floor(Number(marked.credits_charged) || 1)),
  });
  if (error) throw error;
}

async function runStubPipeline(supabase, job) {
  // Prove queue → done without FFmpeg. Prefer Storage when bucket exists; else public sample.
  const sampleUrl =
    "https://videos.pexels.com/video-files/5532763/5532763-uhd_1440_2732_25fps.mp4";

  try {
    const path = `${job.user_id}/${job.id}.txt`;
    const body = Buffer.from(
      `stub render for ${job.id} at ${new Date().toISOString()}`,
      "utf8"
    );
    const { error: uploadError } = await supabase.storage
      .from(RENDERS_BUCKET)
      .upload(path, body, {
        contentType: "text/plain",
        upsert: true,
      });

    if (!uploadError) {
      console.log(
        JSON.stringify({
          event: "stub_storage_ok",
          video_id: job.id,
          path,
        })
      );
    }
  } catch (err) {
    console.warn("stub storage skipped:", err.message);
  }

  return { videoUrl: sampleUrl, thumbnailUrl: null };
}

async function processJob(supabase, job) {
  const started = Date.now();
  console.log(
    JSON.stringify({
      event: "job_claimed",
      video_id: job.id,
      attempt: job.attempts,
      worker_id: WORKER_ID,
    })
  );

  const heartbeatTimer = setInterval(() => {
    void heartbeat(supabase, job.id).catch((err) => {
      console.warn("heartbeat failed", err.message);
    });
  }, Math.max(15_000, Math.floor(LEASE_SECONDS * 1000) / 3));

  try {
    await heartbeat(supabase, job.id);

    const result = STUB_RENDER
      ? await runStubPipeline(supabase, job)
      : await runRenderPipeline(supabase, job, { bucket: RENDERS_BUCKET });

    await completeJob(supabase, job.id, result);

    console.log(
      JSON.stringify({
        event: "job_done",
        video_id: job.id,
        duration_ms: Date.now() - started,
        stub: STUB_RENDER,
      })
    );
  } catch (err) {
    await failJob(supabase, job, err);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function main() {
  const supabase = getSupabase();
  console.log(
    JSON.stringify({
      event: "worker_start",
      worker_id: WORKER_ID,
      stub: STUB_RENDER,
      lease_seconds: LEASE_SECONDS,
    })
  );

  for (;;) {
    try {
      const job = await claimJob(supabase);
      if (!job?.id) {
        await sleep(POLL_MS);
        continue;
      }
      await processJob(supabase, job);
    } catch (err) {
      console.error("worker loop error:", err);
      await sleep(5000);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
