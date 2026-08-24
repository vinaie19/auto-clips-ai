import { readFile } from "node:fs/promises";

/**
 * Upload MP4 (+ optional jpg) to Supabase Storage and return public URLs.
 */
export async function uploadRenderArtifacts(
  supabase,
  { bucket, userId, videoId, videoPath, thumbPath }
) {
  const videoKey = `${userId}/${videoId}.mp4`;
  const videoBytes = await readFile(videoPath);

  const { error: videoError } = await supabase.storage.from(bucket).upload(videoKey, videoBytes, {
    contentType: "video/mp4",
    upsert: true,
  });

  if (videoError) {
    const err = new Error(`Storage upload failed: ${videoError.message}`);
    err.status = 503;
    throw err;
  }

  const { data: videoPublic } = supabase.storage.from(bucket).getPublicUrl(videoKey);

  let thumbnailUrl = null;
  if (thumbPath) {
    const thumbKey = `${userId}/${videoId}.jpg`;
    const thumbBytes = await readFile(thumbPath);
    const { error: thumbError } = await supabase.storage
      .from(bucket)
      .upload(thumbKey, thumbBytes, {
        contentType: "image/jpeg",
        upsert: true,
      });
    if (!thumbError) {
      const { data: thumbPublic } = supabase.storage.from(bucket).getPublicUrl(thumbKey);
      thumbnailUrl = thumbPublic.publicUrl;
    }
  }

  return {
    videoUrl: videoPublic.publicUrl,
    thumbnailUrl,
  };
}
