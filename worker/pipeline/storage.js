import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/** Hard per-file upload ceiling (100 MB). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function isR2() {
  return process.env.STORAGE_BACKEND === "r2";
}

let r2Client = null;
function getR2Client() {
  if (r2Client) return r2Client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 not configured: STORAGE_BACKEND=r2 but R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY missing"
    );
  }
  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 1,
  });
  return r2Client;
}

/** Map an SDK/supabase error to one with a numeric `status` so worker retry
 *  classification (`isRetryableError`) stays correct. */
function wrapUploadError(err, context) {
  const status = Number(
    err?.$metadata?.httpStatusCode ?? err?.status ?? err?.statusCode ?? 503
  );
  const out = new Error(`${context}: ${err?.message || err}`);
  out.status = status;
  return out;
}

/**
 * Reject files larger than MAX_UPLOAD_BYTES before any network I/O.
 * @returns {Promise<number>} file size in bytes
 */
export async function assertUploadSize(filePath) {
  const { size } = await stat(filePath);
  if (size > MAX_UPLOAD_BYTES) {
    const err = new Error(
      `Upload exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit: ${filePath} (${size} bytes)`
    );
    err.status = 413; // non-retryable -> failJob terminal -> credit refund
    throw err;
  }
  return size;
}

/**
 * Upload one local file, streaming (never buffered in RAM).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function uploadFile(
  supabase,
  { bucket, key, filePath, contentType }
) {
  const size = await assertUploadSize(filePath);

  if (isR2()) {
    try {
      await getR2Client().send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET || "shortclips-renders",
          Key: key,
          Body: createReadStream(filePath),
          ContentType: contentType,
          ContentLength: size,
        })
      );
    } catch (err) {
      throw wrapUploadError(err, `R2 upload failed for ${key}`);
    }
    return;
  }

  try {
    const { error } = await supabase.storage.from(bucket).upload(
      key,
      createReadStream(filePath),
      {
        contentType,
        upsert: true,
        duplex: "half",
        headers: { "content-length": String(size) },
      }
    );
    if (error) throw wrapUploadError(error, `Supabase upload failed for ${key}`);
  } catch (err) {
    if (err.status) throw err;
    throw wrapUploadError(err, `Supabase upload failed for ${key}`);
  }
}

/**
 * Public URL for a key, honoring the active backend.
 */
export function publicUrl(bucket, key, supabase) {
  if (isR2()) {
    const base = process.env.R2_PUBLIC_BASE_URL;
    if (!base) {
      throw new Error("R2 not configured: R2_PUBLIC_BASE_URL missing");
    }
    return `${base.replace(/\/+$/, "")}/${key}`;
  }
  return supabase.storage.from(bucket).getPublicUrl(key).data.publicUrl;
}
