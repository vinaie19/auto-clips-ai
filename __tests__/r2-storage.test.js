import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, truncate, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@aws-sdk/client-s3", () => import("./mocks/client-s3.js"));

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  MAX_UPLOAD_BYTES,
  assertUploadSize,
  uploadFile,
  publicUrl,
} from "../worker/pipeline/storage.js";

afterEach(() => vi.unstubAllEnvs());

describe("MAX_UPLOAD_BYTES", () => {
  it("is exactly 100 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe("assertUploadSize", () => {
  it("passes files at or under 100 MB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r2-size-"));
    const p = join(dir, "ok.mp4");
    await writeFile(p, "hello");
    await expect(assertUploadSize(p)).resolves.toBe(5);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects files over 100 MB with status 413", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r2-size-"));
    const p = join(dir, "big.mp4");
    await writeFile(p, "");
    await truncate(p, 101 * 1024 * 1024); // sparse — instant, no disk cost
    await expect(assertUploadSize(p)).rejects.toMatchObject({ status: 413 });
    await rm(dir, { recursive: true, force: true });
  });
});

describe("publicUrl", () => {
  it("joins base and key on R2, stripping a trailing slash", () => {
    vi.stubEnv("STORAGE_BACKEND", "r2");
    vi.stubEnv("R2_PUBLIC_BASE_URL", "https://cdn.example.com/");
    expect(publicUrl("renders", "u/1.mp4", {})).toBe(
      "https://cdn.example.com/u/1.mp4"
    );
  });

  it("delegates to supabase.storage otherwise", () => {
    vi.stubEnv("STORAGE_BACKEND", "supabase");
    const supabase = {
      storage: {
        from: (bucket) => ({
          getPublicUrl: (key) => ({
            data: { publicUrl: `https://proj.supabase.co/${bucket}/${key}` },
          }),
        }),
      },
    };
    expect(publicUrl("renders", "u/1.mp4", supabase)).toBe(
      "https://proj.supabase.co/renders/u/1.mp4"
    );
  });
});

describe("uploadFile", () => {
  it("uploads to R2 via PutObject with explicit ContentLength", async () => {
    vi.stubEnv("STORAGE_BACKEND", "r2");
    vi.stubEnv("R2_ACCOUNT_ID", "acct123");
    vi.stubEnv("R2_ACCESS_KEY_ID", "ak");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "sk");
    vi.stubEnv("R2_BUCKET", "shortclips-renders");

    const dir = await mkdtemp(join(tmpdir(), "r2-up-"));
    const p = join(dir, "v.mp4");
    await writeFile(p, "hello");

    await uploadFile({}, {
      bucket: "renders",
      key: "u/1.mp4",
      filePath: p,
      contentType: "video/mp4",
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "auto",
        endpoint: "https://acct123.r2.cloudflarestorage.com",
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        maxAttempts: 1,
      })
    );
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "shortclips-renders",
        Key: "u/1.mp4",
        ContentType: "video/mp4",
        ContentLength: 5,
      })
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("uploads to Supabase with the existing stream options", async () => {
    vi.stubEnv("STORAGE_BACKEND", "supabase");
    const upload = vi.fn().mockResolvedValue({ error: null });
    const supabase = { storage: { from: () => ({ upload }) } };

    const dir = await mkdtemp(join(tmpdir(), "r2-sup-"));
    const p = join(dir, "v.mp4");
    await writeFile(p, "hello");

    await uploadFile(supabase, {
      bucket: "renders",
      key: "u/1.mp4",
      filePath: p,
      contentType: "video/mp4",
    });

    expect(upload).toHaveBeenCalledWith(
      "u/1.mp4",
      expect.anything(),
      expect.objectContaining({
        contentType: "video/mp4",
        duplex: "half",
        headers: { "content-length": "5" },
      })
    );
    await rm(dir, { recursive: true, force: true });
  });
});
