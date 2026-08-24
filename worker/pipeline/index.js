import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { synthesizeSpeech } from "./tts.js";
import { downloadClips } from "./download.js";
import { writeAssCaptions, chunkIntoPunchyBlocks } from "./captions.js";
import { resolveCaptionTimings } from "./align-captions.js";
import { renderVerticalMp4, grabThumbnail, fitAudioToTarget } from "./ffmpeg.js";
import { uploadRenderArtifacts } from "./upload.js";
import { computeSegmentDurations } from "./segment-durations.js";

const ASPECT_SIZES = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
};

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
    const captionsEnabled = payload.captionsEnabled !== false;
    const targetDurationSeconds = [30, 45, 60].includes(Number(payload.targetDurationSeconds))
      ? Number(payload.targetDurationSeconds)
      : 45;
    const aspectRatio = ASPECT_SIZES[payload.aspectRatio]
      ? payload.aspectRatio
      : "9:16";
    const { width, height } = ASPECT_SIZES[aspectRatio];
    const workDir = join(tmpdir(), `autoclips-${job.id}-${Date.now()}`);

    await mkdir(workDir, { recursive: true });

    try {
      const rawAudioPath = join(workDir, "audio-raw.mp3");
      console.log(
        JSON.stringify({
          event: "step_tts",
          video_id: job.id,
          voice,
          target_s: targetDurationSeconds,
          aspect: aspectRatio,
        })
      );
      await synthesizeSpeech(script, voice, rawAudioPath);

      const fittedPath = join(workDir, "audio.mp3");
      const fitted = await fitAudioToTarget(
        rawAudioPath,
        fittedPath,
        targetDurationSeconds
      );
      const audioPath = fitted.path;
      const duration = Math.min(
        Math.max(fitted.duration || targetDurationSeconds, 8),
        targetDurationSeconds * 1.15
      );

      console.log(
        JSON.stringify({
          event: "step_download",
          video_id: job.id,
          clips: pexelsUrls.length,
          motif: payload.visualMotif || null,
          queries: Array.isArray(payload.visualBeats)
            ? payload.visualBeats.map((b) => b.query)
            : payload.visualQueries || [],
        })
      );
      const clipPaths = await downloadClips(pexelsUrls, workDir);

      const beatCount = clipPaths.length;
      const beatWeights = Array.isArray(payload.visualBeats)
        ? payload.visualBeats.map((b) => {
            const w = Number(b?.weight);
            if (Number.isFinite(w) && w > 0) return w;
            const lineWords = String(b?.line || "")
              .trim()
              .split(/\s+/)
              .filter(Boolean).length;
            return Math.max(1, lineWords || 1);
          })
        : null;
      const segmentDurations = computeSegmentDurations(duration, beatCount, {
        weights:
          beatWeights && beatWeights.length === beatCount ? beatWeights : undefined,
        script,
      });

      let assPath = null;
      if (captionsEnabled) {
        const blocks = chunkIntoPunchyBlocks(script, 3);
        console.log(
          JSON.stringify({
            event: "step_caption_align",
            video_id: job.id,
            blocks: blocks.length,
          })
        );
        const timings = await resolveCaptionTimings(blocks, audioPath, duration);
        assPath = join(workDir, "captions.ass");
        writeAssCaptions(assPath, blocks, duration, subtitleTheme, {
          width,
          height,
          timings,
        });
      }

      const outPath = join(workDir, "out.mp4");
      console.log(
        JSON.stringify({
          event: "step_ffmpeg",
          video_id: job.id,
          duration_s: Number(duration.toFixed(2)),
          beats: beatCount,
          segments: segmentDurations,
          captions: captionsEnabled,
          size: `${width}x${height}`,
        })
      );
      await renderVerticalMp4({
        clipPaths,
        audioPath,
        assPath,
        outPath,
        targetDuration: duration,
        segmentDurations,
        width,
        height,
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
