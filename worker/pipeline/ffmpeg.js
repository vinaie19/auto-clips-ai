import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/**
 * Prefer env → packaged static binary (if present) → system PATH.
 * A1/ARM images often lack linux/arm64 binaries in *-static packages.
 */
function resolveBin(envKey, staticCandidate, fallbackName) {
  const fromEnv = process.env[envKey];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (typeof staticCandidate === "string" && staticCandidate && existsSync(staticCandidate)) {
    return staticCandidate;
  }
  const which = spawnSync("which", [fallbackName], { encoding: "utf8" });
  const pathOnDisk = which.status === 0 ? String(which.stdout || "").trim() : "";
  if (pathOnDisk && existsSync(pathOnDisk)) return pathOnDisk;
  return fallbackName;
}

const FFPROBE = resolveBin(
  "FFPROBE_PATH",
  ffprobeStatic?.path || ffprobeStatic,
  "ffprobe"
);
const FFMPEG = resolveBin("FFMPEG_PATH", ffmpegPath, "ffmpeg");

/** Cap decode/encode parallelism for small Lightsail boxes (~1–2 GB). */
const THREAD_ARGS = ["-threads", "1", "-filter_threads", "1"];

/**
 * Segment-then-reencode path for ~1–2 GB hosts.
 * Default is a single filter_complex encode (one libx264 pass).
 */
const LOW_MEM =
  process.env.FFMPEG_LOW_MEM === "1" || process.env.FFMPEG_LOW_MEM === "true";

/** Escape a path for ffmpeg concat demuxer list files. */
function escapeConcatPath(p) {
  return p.replace(/'/g, "'\\''");
}

function run(bin, args, label = "ffmpeg") {
  return new Promise((resolve, reject) => {
    if (!bin) {
      const err = new Error("ffmpeg is not installed");
      err.status = 500;
      reject(err);
      return;
    }

    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`${label} failed (exit ${code}): ${stderr.slice(-1200)}`);
        err.status = 500;
        reject(err);
      }
    });
  });
}

export async function probeDurationSeconds(filePath) {
  const { stdout } = await run(
    FFPROBE,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    "ffprobe"
  );
  const n = Number.parseFloat(String(stdout).trim());
  return Number.isFinite(n) ? n : 45;
}

/** Escape path for ffmpeg ass filter. */
function escapeFilterPath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * Build atempo filter chain (each filter must be within 0.5–2.0).
 * @param {number} speed - playback rate (>1 = faster / shorter)
 */
export function buildAtempoFilter(speed) {
  let remaining = Math.min(Math.max(Number(speed) || 1, 0.5), 4);
  const parts = [];
  while (remaining > 2.0001) {
    parts.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5 - 1e-6) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts.join(",");
}

/**
 * Fit TTS length to the chosen target (30/45/60).
 * - Too long → speed up (atempo > 1)
 * - Too short → slow down mildly (atempo >= 0.85) so short scripts don't stay ~35s on a 60s setting
 * Returns path + fitted duration + rawDuration (for caption timestamp scaling).
 */
export async function fitAudioToTarget(audioPath, fittedPath, targetSeconds) {
  const current = await probeDurationSeconds(audioPath);
  const target = Math.max(8, Number(targetSeconds) || 45);
  const rawDuration = Number.isFinite(current) && current > 0 ? current : target;

  if (!Number.isFinite(current) || current <= 0) {
    return { path: audioPath, duration: target, rawDuration: target };
  }

  // Within ~6% of target — keep as-is.
  if (current <= target * 1.06 && current >= target * 0.94) {
    return { path: audioPath, duration: rawDuration, rawDuration };
  }

  // Cap slowdown so VO does not sound drunken; primary fix is longer scripts.
  const MIN_SPEED = 0.85;
  const MAX_SPEED = 4;
  let speed = current / target;
  speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));

  // After clamping, if still essentially unchanged, skip ffmpeg.
  const projected = current / speed;
  if (Math.abs(projected - current) < 0.35) {
    return { path: audioPath, duration: rawDuration, rawDuration };
  }

  const filter = buildAtempoFilter(speed);
  await run(
    FFMPEG,
    ["-y", ...THREAD_ARGS, "-i", audioPath, "-filter:a", filter, "-vn", fittedPath],
    "ffmpeg-atempo"
  );
  const fitted = await probeDurationSeconds(fittedPath);
  return {
    path: fittedPath,
    duration: fitted || projected || target,
    rawDuration,
  };
}

function resolveSegmentDurations(n, targetDuration, segmentDurations) {
  if (Array.isArray(segmentDurations) && segmentDurations.length === n) {
    let segs = segmentDurations.map((s) => Math.max(0.5, Number(s) || 0));
    const sum = segs.reduce((a, b) => a + b, 0);
    if (sum > 0 && Math.abs(sum - targetDuration) > 0.05) {
      const scale = targetDuration / sum;
      segs = segs.map((s) => Number((s * scale).toFixed(3)));
    }
    return segs;
  }
  const even = Number((targetDuration / n).toFixed(3));
  return Array.from({ length: n }, () => even);
}

const SCALE_VF = (w, h) =>
  `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30,format=yuv420p`;

/**
 * One filter_complex: scale/concat/(optional ASS) → single libx264 encode.
 * Uses more peak RAM than the segment path; avoid on ~1–2 GB hosts.
 */
async function renderSinglePass({
  clipPaths,
  audioPath,
  assPath,
  outPath,
  segs,
  width,
  height,
}) {
  const n = clipPaths.length;
  const scaleChain = SCALE_VF(width, height);

  const inputs = [];
  for (let i = 0; i < n; i += 1) {
    inputs.push("-stream_loop", "-1", "-t", String(segs[i]), "-i", clipPaths[i]);
  }
  inputs.push("-i", audioPath);

  const parts = [];
  for (let i = 0; i < n; i += 1) {
    parts.push(`[${i}:v]${scaleChain},setpts=PTS-STARTPTS[v${i}]`);
  }
  const concatIn = Array.from({ length: n }, (_, i) => `[v${i}]`).join("");
  parts.push(`${concatIn}concat=n=${n}:v=1:a=0[vcat]`);

  let vMap = "[vcat]";
  if (assPath) {
    parts.push(`[vcat]ass='${escapeFilterPath(assPath)}'[vout]`);
    vMap = "[vout]";
  }

  console.log(
    JSON.stringify({
      event: "ffmpeg_single_pass",
      clips: n,
      captions: Boolean(assPath),
    })
  );

  await run(
    FFMPEG,
    [
      "-y",
      ...THREAD_ARGS,
      ...inputs,
      "-filter_complex",
      parts.join(";"),
      "-map",
      vMap,
      "-map",
      `${n}:a`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      outPath,
    ],
    "ffmpeg"
  );
}

/**
 * Encode one clip at a time, concat, then mux audio (re-encode only if ASS).
 * Lower peak RAM; with captions this is two lossy x264 stages.
 */
async function renderLowMemSegments({
  clipPaths,
  audioPath,
  assPath,
  outPath,
  segs,
  width,
  height,
}) {
  const n = clipPaths.length;
  const workDir = dirname(outPath);
  const scaleVf = SCALE_VF(width, height);

  const segPaths = [];
  for (let i = 0; i < n; i += 1) {
    const segPath = join(workDir, `seg-${i}.mp4`);
    console.log(
      JSON.stringify({
        event: "ffmpeg_seg",
        index: i,
        of: n,
        duration_s: segs[i],
      })
    );
    await run(
      FFMPEG,
      [
        "-y",
        ...THREAD_ARGS,
        "-stream_loop",
        "-1",
        "-t",
        String(segs[i]),
        "-i",
        clipPaths[i],
        "-vf",
        scaleVf,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        segPath,
      ],
      `ffmpeg-seg-${i}`
    );
    segPaths.push(segPath);
  }

  const listPath = join(workDir, "concat.txt");
  await writeFile(
    listPath,
    segPaths.map((p) => `file '${escapeConcatPath(p)}'`).join("\n") + "\n",
    "utf8"
  );

  const finalArgs = [
    "-y",
    ...THREAD_ARGS,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-i",
    audioPath,
  ];

  if (assPath) {
    finalArgs.push(
      "-vf",
      `ass='${escapeFilterPath(assPath)}'`,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      outPath
    );
  } else {
    finalArgs.push(
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      outPath
    );
  }

  await run(FFMPEG, finalArgs, "ffmpeg");
}

/**
 * Stitch clips, burn ASS, mux TTS audio at the chosen aspect ratio.
 *
 * Default: one filter_complex → single libx264 encode (scale + concat + ASS).
 * Set FFMPEG_LOW_MEM=1 on ~1–2 GB hosts to encode one clip at a time instead
 * (avoids OOM; with captions that path re-encodes after concat).
 */
export async function renderVerticalMp4({
  clipPaths,
  audioPath,
  assPath,
  outPath,
  targetDuration,
  segmentDurations,
  width = 1080,
  height = 1920,
}) {
  const n = clipPaths.length;
  if (n === 0) throw new Error("invalid payload: no clips");

  const w = Math.max(16, Math.round(Number(width) || 1080));
  const h = Math.max(16, Math.round(Number(height) || 1920));
  const segs = resolveSegmentDurations(n, targetDuration, segmentDurations);
  const args = {
    clipPaths,
    audioPath,
    assPath,
    outPath,
    segs,
    width: w,
    height: h,
  };

  if (LOW_MEM) {
    console.log(JSON.stringify({ event: "ffmpeg_mode", mode: "low_mem_segments" }));
    await renderLowMemSegments(args);
    return;
  }

  console.log(JSON.stringify({ event: "ffmpeg_mode", mode: "single_pass" }));
  await renderSinglePass(args);
}

export async function grabThumbnail(videoPath, outPath) {
  await run(
    FFMPEG,
    ["-y", "-ss", "1", "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath],
    "ffmpeg-thumb"
  );
}
