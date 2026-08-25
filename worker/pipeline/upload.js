import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * Stream a local file into Supabase Storage (avoids buffering the whole MP4 in RAM).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} bucket
 * @param {string} key
 * @param {string} filePath
 * @param {string} contentType
 */
async function uploadFileStream(supabase, bucket, key, filePath, contentType) {
  const { size } = await stat(filePath);
  const stream = createReadStream(filePath);
  const { error } = await supabase.storage.from(bucket).upload(key, stream, {
    contentType,
    upsert: true,
    duplex: "half",
    headers: {
      "content-length": String(size),
    },
  });
  return error;
}

/**
 * Upload MP4 (+ optional jpg) to Supabase Storage and return public URLs.
 */
export async function uploadRenderArtifacts(
  supabase,
  { bucket, userId, videoId, videoPath, thumbPath }
) {
  const videoKey = `${userId}/${videoId}.mp4`;
  const videoError = await uploadFileStream(
    supabase,
    bucket,
    videoKey,
    videoPath,
    "video/mp4"
  );

  if (videoError) {
    const err = new Error(`Storage upload failed: ${videoError.message}`);
    err.status = 503;
    throw err;
  }

  const { data: videoPublic } = supabase.storage.from(bucket).getPublicUrl(videoKey);

  let thumbnailUrl = null;
  if (thumbPath) {
    const thumbKey = `${userId}/${videoId}.jpg`;
    const thumbError = await uploadFileStream(
      supabase,
      bucket,
      thumbKey,
      thumbPath,
      "image/jpeg"
    );
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
