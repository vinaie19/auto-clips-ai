import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const FFPROBE = ffprobeStatic.path || ffprobeStatic;
const FFMPEG = ffmpegPath;

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
    ["-y", "-i", audioPath, "-filter:a", filter, "-vn", fittedPath],
    "ffmpeg-atempo"
  );
  const fitted = await probeDurationSeconds(fittedPath);
  return {
    path: fittedPath,
    duration: fitted || projected || target,
    rawDuration,
  };
}

/**
 * Stitch clips, burn ASS, mux TTS audio at the chosen aspect ratio.
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

  let segs;
  if (Array.isArray(segmentDurations) && segmentDurations.length === n) {
    segs = segmentDurations.map((s) => Math.max(0.5, Number(s) || 0));
    const sum = segs.reduce((a, b) => a + b, 0);
    if (sum > 0 && Math.abs(sum - targetDuration) > 0.05) {
      const scale = targetDuration / sum;
      segs = segs.map((s) => Number((s * scale).toFixed(3)));
    }
  } else {
    const even = Number((targetDuration / n).toFixed(3));
    segs = Array.from({ length: n }, () => even);
  }

  const inputs = [];
  for (let i = 0; i < n; i += 1) {
    inputs.push("-stream_loop", "-1", "-t", String(segs[i]), "-i", clipPaths[i]);
  }
  inputs.push("-i", audioPath);

  const parts = [];
  for (let i = 0; i < n; i += 1) {
    parts.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`
    );
  }
  const concatIn = Array.from({ length: n }, (_, i) => `[v${i}]`).join("");
  parts.push(`${concatIn}concat=n=${n}:v=1:a=0[vcat]`);
  if (assPath) {
    parts.push(`[vcat]ass='${escapeFilterPath(assPath)}'[vout]`);
  } else {
    parts.push(`[vcat]null[vout]`);
  }

  const args = [
    "-y",
    ...inputs,
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[vout]",
    "-map",
    `${n}:a`,
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
    outPath,
  ];

  await run(FFMPEG, args, "ffmpeg");
}

export async function grabThumbnail(videoPath, outPath) {
  await run(
    FFMPEG,
    ["-y", "-ss", "1", "-i", videoPath, "-frames:v", "1", "-q:v", "3", outPath],
    "ffmpeg-thumb"
  );
}
