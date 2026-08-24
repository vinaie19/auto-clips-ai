import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { synthesizeSpeech } from "./tts.js";
import { downloadClips } from "./download.js";
import { writeAssCaptions, chunkIntoPunchyBlocks } from "./captions.js";
import { renderVerticalMp4, grabThumbnail, probeDurationSeconds } from "./ffmpeg.js";
import { uploadRenderArtifacts } from "./upload.js";

/**
 * Full render: TTS → download → captions → FFmpeg → Storage.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {object} job - videos row
 * @param {{ bucket?: string }} [opts]
 */
export async function runRenderPipeline(supabase, job, opts = {}) {
  const bucket = opts.bucket || process.env.RENDERS_BUCKET || "renders";
  const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
  const script = String(payload.script || job.script || "").trim();
  if (!script) {
    const err = new Error("empty script");
    err.status = 400;
    throw err;
  }

    const urls = Array.isArray(payload.visualBeats)
      ? payload.visualBeats.map((b) => b?.url).filter(Boolean)
      : [];
    const pexelsUrls =
      urls.length > 0
        ? urls
        : Array.isArray(payload.pexelsVideoUrls)
          ? payload.pexelsVideoUrls.filter((u) => typeof u === "string" && u.length > 0)
          : [];
    if (pexelsUrls.length === 0) {
      const err = new Error("invalid payload: missing pexelsVideoUrls");
      err.status = 400;
      throw err;
    }

    const voice = payload.voice || "nova";
    const subtitleTheme = payload.subtitleTheme || job.subtitle_theme || "Viral Yellow";
    const workDir = join(tmpdir(), `autoclips-${job.id}-${Date.now()}`);

    await mkdir(workDir, { recursive: true });

    try {
      const audioPath = join(workDir, "audio.mp3");
      console.log(JSON.stringify({ event: "step_tts", video_id: job.id }));
      await synthesizeSpeech(script, voice, audioPath);

      const audioDuration = await probeDurationSeconds(audioPath);
      const duration = Math.min(Math.max(audioDuration || 45, 8), 60);

      console.log(
        JSON.stringify({
          event: "step_download",
          video_id: job.id,
          clips: pexelsUrls.length,
          queries: Array.isArray(payload.visualBeats)
            ? payload.visualBeats.map((b) => b.query)
            : payload.visualQueries || [],
        })
      );
      const clipPaths = await downloadClips(pexelsUrls, workDir);

      // One visual beat ≈ equal share of narration (order matches script)
      const beatCount = clipPaths.length;
      const segmentDurations = Array.from({ length: beatCount }, () =>
        Number((duration / beatCount).toFixed(3))
      );

      const blocks = chunkIntoPunchyBlocks(script, 3);
      const assPath = join(workDir, "captions.ass");
      writeAssCaptions(assPath, blocks, duration, subtitleTheme);

      const outPath = join(workDir, "out.mp4");
      console.log(
        JSON.stringify({
          event: "step_ffmpeg",
          video_id: job.id,
          duration_s: Number(duration.toFixed(2)),
          beats: beatCount,
        })
      );
      await renderVerticalMp4({
        clipPaths,
        audioPath,
        assPath,
        outPath,
        targetDuration: duration,
        segmentDurations,
      });

    const thumbPath = join(workDir, "thumb.jpg");
    try {
      await grabThumbnail(outPath, thumbPath);
    } catch (err) {
      console.warn("thumbnail skipped:", err.message);
    }

    console.log(JSON.stringify({ event: "step_upload", video_id: job.id }));
    const uploaded = await uploadRenderArtifacts(supabase, {
      bucket,
      userId: job.user_id,
      videoId: job.id,
      videoPath: outPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
    });

    return {
      videoUrl: uploaded.videoUrl,
      thumbnailUrl: uploaded.thumbnailUrl || null,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export { chunkIntoPunchyBlocks };
