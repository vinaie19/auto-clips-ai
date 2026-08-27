import { uploadFile, publicUrl } from "./storage.js";

/**
 * Upload MP4 (+ optional jpg) and return public URLs.
 * The 100MB cap is enforced inside uploadFile; an over-limit video throws
 * status 413, which failJob treats as terminal (no retry) and refunds.
 */
export async function uploadRenderArtifacts(
  supabase,
  { bucket, userId, videoId, videoPath, thumbPath }
) {
  const videoKey = `${userId}/${videoId}.mp4`;
  await uploadFile(supabase, {
    bucket,
    key: videoKey,
    filePath: videoPath,
    contentType: "video/mp4",
  });
  const videoUrl = publicUrl(bucket, videoKey, supabase);

  let thumbnailUrl = null;
  if (thumbPath) {
    try {
      const thumbKey = `${userId}/${videoId}.jpg`;
      await uploadFile(supabase, {
        bucket,
        key: thumbKey,
        filePath: thumbPath,
        contentType: "image/jpeg",
      });
      thumbnailUrl = publicUrl(bucket, thumbKey, supabase);
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "thumb_upload_skipped",
          video_id: videoId,
          error: err.message,
        })
      );
    }
  }

  return { videoUrl, thumbnailUrl };
}
