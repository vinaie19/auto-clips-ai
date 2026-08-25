import { draftScript } from "./script.js";
import { planVisualBeats } from "./visual-queries.js";
import { fetchBrollForQueries } from "./pexels-broll.js";

const ASPECT_ORIENTATION = {
  "9:16": "portrait",
  "16:9": "landscape",
  "1:1": "square",
};

/**
 * True when payload already has script + clip URLs (legacy enqueue or prior prepare).
 * @param {object} job
 */
export function isPayloadPrepared(job) {
  const payload = job?.payload && typeof job.payload === "object" ? job.payload : {};
  const script = String(payload.script || job?.script || "").trim();
  const fromBeats = Array.isArray(payload.visualBeats)
    ? payload.visualBeats.map((b) => b?.url).filter(Boolean)
    : [];
  const fromUrls = Array.isArray(payload.pexelsVideoUrls)
    ? payload.pexelsVideoUrls.filter((u) => typeof u === "string" && u.length > 0)
    : [];
  const urls = fromBeats.length > 0 ? fromBeats : fromUrls;
  return Boolean(script && urls.length > 0);
}

/**
 * Draft script, plan beats, fetch Pexels/vision B-roll; persist onto the job row.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {object} job
 * @returns {Promise<object>} updated job (payload + script filled)
 */
export async function prepareJobAssets(supabase, job) {
  const payload =
    job.payload && typeof job.payload === "object" ? { ...job.payload } : {};
  const topic = String(payload.topic || job.prompt || "").trim();
  if (!topic) {
    const err = new Error("invalid payload: missing topic");
    err.status = 400;
    throw err;
  }

  const tone = String(payload.tone || job.tone || "Cinematic").trim() || "Cinematic";
  const targetDurationSeconds = [30, 45, 60].includes(
    Number(payload.targetDurationSeconds)
  )
    ? Number(payload.targetDurationSeconds)
    : 45;
  const aspectRatio = ASPECT_ORIENTATION[payload.aspectRatio]
    ? payload.aspectRatio
    : "9:16";

  console.log(
    JSON.stringify({
      event: "step_prepare",
      video_id: job.id,
      topic: topic.slice(0, 80),
      tone,
      target_s: targetDurationSeconds,
      aspect: aspectRatio,
    })
  );

  await supabase
    .from("videos")
    .update({
      progress: "preparing",
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  const script = await draftScript(topic, tone, targetDurationSeconds);
  console.log(
    JSON.stringify({
      event: "prepare_script_ok",
      video_id: job.id,
      chars: script.length,
    })
  );

  const visualPlan = await planVisualBeats(script, topic);
  console.log(
    JSON.stringify({
      event: "prepare_beats_ok",
      video_id: job.id,
      beats: visualPlan.queries?.length || 0,
      motif: visualPlan.motif || null,
    })
  );

  const { pexelsVideoUrls, visualBeats } = await fetchBrollForQueries(
    visualPlan.queries,
    {
      weights: visualPlan.weights,
      lines: visualPlan.lines,
      motif: visualPlan.motif,
      orientation: ASPECT_ORIENTATION[aspectRatio],
    }
  );
  console.log(
    JSON.stringify({
      event: "prepare_broll_ok",
      video_id: job.id,
      clips: pexelsVideoUrls.length,
    })
  );

  const nextPayload = {
    ...payload,
    topic,
    tone,
    targetDurationSeconds,
    aspectRatio,
    script,
    pexelsVideoUrls,
    visualBeats,
    visualQueries: visualPlan.queries,
    visualLines: visualPlan.lines,
    visualMotif: visualPlan.motif,
    visualAvoid: visualPlan.avoid,
    preparedAt: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("videos")
    .update({
      script,
      payload: nextPayload,
      progress: "rendering",
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("prepare persist failed:", error);
    const err = new Error("Failed to persist prepared render payload.");
    err.status = 500;
    throw err;
  }

  return data || { ...job, script, payload: nextPayload };
}
