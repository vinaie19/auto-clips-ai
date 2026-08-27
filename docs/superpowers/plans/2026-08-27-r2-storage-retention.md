# Cloudflare R2 Object Storage + 100MB Cap + 14-Day Retention

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move rendered MP4/thumbnail uploads from Supabase Storage to Cloudflare R2, enforce a hard 100MB-per-file cap, serve over a custom domain, and delete objects (plus keep the DB consistent) after a 14-day retention window.

**Architecture:** The render worker is the only place that touches object storage — the Next.js app only reads the public `video_url`/`thumbnail_url` strings already stored in `videos`. So this is a single integration point: replace `worker/pipeline/upload.js`'s Supabase call with a small storage abstraction that branches on `STORAGE_BACKEND` (`supabase` | `r2`). Object deletion is guaranteed by a Cloudflare R2 lifecycle rule (zero code, runs even if the worker is down); a lightweight sweep in the worker's existing poll loop marks expired DB rows (null URLs + `status='expired'`) so the UI shows no dead links.

**Tech Stack:** Node 20+ (ESM worker), `@aws-sdk/client-s3` (S3-compatible R2 API), Supabase Postgres (`videos` table), Vitest.

**Spec:** Extends `docs/plans/2026-08-24-self-hosted-render-queue-plan.md` (Task 8c, "Production object storage — Cloudflare R2") and its companion `docs/plans/2026-08-24-self-hosted-render-queue-spec.md`. The 100MB cap and 14-day retention are new requirements from the user and are specified inline below.

## Global Constraints

- **100MB hard cap per file** — enforced server-side in the worker before any upload. A render whose output exceeds 100MB fails terminally (no retry burn) and its credit is refunded via the existing `failJob` → `refundIfNeeded` path.
- **14-day retention** — objects are deleted by an R2 lifecycle rule (`Delete`, age 14 days); the DB row is marked `expired` by the worker sweep.
- **Custom public domain** for serving (e.g. `https://cdn.<yourdomain>.com`), not the `*.r2.dev` subdomain — enables Cloudflare CDN caching so repeat plays never hit origin.
- **No migration of existing test-phase Supabase objects.** Historical Supabase URLs may stop playing if Supabase retention later removes them; only new renders go to R2.
- **Local/default backend stays Supabase** (`STORAGE_BACKEND` unset or `supabase`) so `npm run test` and local worker smoke need no R2 credentials. Prod sets `STORAGE_BACKEND=r2`.
- The `videos.status` column is free `text` (no CHECK constraint — verified in `supabase/schema.sql` and migrations), so adding `status='expired'` is safe. The `claim_render_job` RPC only ever claims `status='pending'`, so expired rows are never re-claimed.

## File Structure

- `worker/pipeline/storage.js` — **create.** Storage abstraction: `MAX_UPLOAD_BYTES`, `assertUploadSize`, `uploadFile`, `publicUrl`, backend switch. Single seam for Supabase vs R2 and for the 100MB cap.
- `worker/pipeline/upload.js` — **modify.** Rewrite `uploadRenderArtifacts` to call the abstraction instead of `supabase.storage` directly. Preserves the current tolerant-thumbnail behavior.
- `worker/pipeline/retention.js` — **create.** `RETENTION_DAYS`, `retentionCutoff`, `sweepExpiredVideos`.
- `worker/index.js` — **modify.** Import and call `sweepExpiredVideos` in the `main()` poll loop, throttled.
- `worker/package.json` / `worker/package-lock.json` — **modify.** Add `@aws-sdk/client-s3`.
- `worker/.env.example`, `worker/README.md` — **modify.** Document R2 + retention env.
- `src/components/CreatorWorkspace.js` — **modify.** One `formatStatus` line so `expired` renders "Expired".
- `__tests__/r2-storage.test.js`, `__tests__/upload-artifacts.test.js`, `__tests__/retention.test.js` — **create.**

---

### Task 1: Storage abstraction (Supabase + R2) with 100MB cap

**Files:**
- Create: `worker/pipeline/storage.js`
- Modify: `worker/package.json`, `worker/package-lock.json`
- Test: `__tests__/r2-storage.test.js`

**Interfaces:**
- Produces: `MAX_UPLOAD_BYTES` (number), `assertUploadSize(filePath)` (Promise<number>, throws `{ status: 413 }` when over), `uploadFile(supabase, { bucket, key, filePath, contentType })` (Promise<void>, throws on error), `publicUrl(bucket, key, supabase)` (string).

- [ ] **Step 1: Install the S3 SDK into the worker**

Run: `npm --prefix worker install @aws-sdk/client-s3`
Expected: `worker/package.json` gains `"@aws-sdk/client-s3": "^3.x"`; `worker/package-lock.json` updated.

- [ ] **Step 2: Write the failing tests**

Create `__tests__/r2-storage.test.js`:

```js
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, truncate, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
  PutObjectCommand: vi.fn((input) => ({ input })),
}));

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
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npm run test -- r2-storage`
Expected: FAIL — `Cannot find module '../worker/pipeline/storage.js'`.

- [ ] **Step 4: Write the implementation**

Create `worker/pipeline/storage.js`:

```js
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
    const err = new Error(
      "R2 not configured: STORAGE_BACKEND=r2 but R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY missing"
    );
    err.status = 500;
    throw err;
  }
  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
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
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npm run test -- r2-storage`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Commit**

```bash
git add worker/pipeline/storage.js worker/package.json worker/package-lock.json __tests__/r2-storage.test.js
git commit -m "feat(worker): add R2/Supabase storage abstraction with 100MB cap"
```

---

### Task 2: Route render uploads through the abstraction

**Files:**
- Modify: `worker/pipeline/upload.js`
- Test: `__tests__/upload-artifacts.test.js`

**Interfaces:**
- Consumes: `uploadFile`, `publicUrl` from `worker/pipeline/storage.js`.
- Produces: `uploadRenderArtifacts(supabase, { bucket, userId, videoId, videoPath, thumbPath })` → `{ videoUrl, thumbnailUrl }` (same signature as today; `worker/pipeline/index.js` call site unchanged).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/upload-artifacts.test.js`:

```js
import { describe, expect, it, vi } from "vitest";

vi.mock("../worker/pipeline/storage.js", () => ({
  uploadFile: vi.fn(),
  publicUrl: vi.fn(),
}));

import { uploadFile, publicUrl } from "../worker/pipeline/storage.js";
import { uploadRenderArtifacts } from "../worker/pipeline/upload.js";

const base = { bucket: "renders", userId: "u", videoId: "1" };

describe("uploadRenderArtifacts", () => {
  it("uploads video + thumbnail with derived keys and returns public URLs", async () => {
    uploadFile.mockResolvedValue(undefined);
    publicUrl.mockImplementation((bucket, key) => `https://cdn/${key}`);

    const res = await uploadRenderArtifacts({}, {
      ...base,
      videoPath: "/tmp/v.mp4",
      thumbPath: "/tmp/t.jpg",
    });

    expect(uploadFile).toHaveBeenCalledWith({}, {
      bucket: "renders",
      key: "u/1.mp4",
      filePath: "/tmp/v.mp4",
      contentType: "video/mp4",
    });
    expect(uploadFile).toHaveBeenCalledWith({}, {
      bucket: "renders",
      key: "u/1.jpg",
      filePath: "/tmp/t.jpg",
      contentType: "image/jpeg",
    });
    expect(res).toEqual({
      videoUrl: "https://cdn/u/1.mp4",
      thumbnailUrl: "https://cdn/u/1.jpg",
    });
  });

  it("keeps the video URL when thumbnail upload fails", async () => {
    uploadFile.mockImplementation(async (_s, { key }) => {
      if (key.endsWith(".jpg")) throw new Error("thumb boom");
    });
    publicUrl.mockImplementation((bucket, key) => `https://cdn/${key}`);

    const res = await uploadRenderArtifacts({}, {
      ...base,
      videoPath: "/tmp/v.mp4",
      thumbPath: "/tmp/t.jpg",
    });

    expect(res.videoUrl).toBe("https://cdn/u/1.mp4");
    expect(res.thumbnailUrl).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm run test -- upload-artifacts`
Expected: FAIL — current `upload.js` imports none of `uploadFile`/`publicUrl`.

- [ ] **Step 3: Rewrite `worker/pipeline/upload.js`**

Replace the file contents with:

```js
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
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npm run test -- upload-artifacts`
Expected: PASS (both tests). Also run the full suite to catch regressions: `npm run test`
Expected: PASS (existing captions/duration-aspect tests keep importing `worker/pipeline/*`).

- [ ] **Step 5: Commit**

```bash
git add worker/pipeline/upload.js __tests__/upload-artifacts.test.js
git commit -m "feat(worker): route render uploads through storage abstraction"
```

---

### Task 3: 14-day retention sweep (DB consistency)

**Files:**
- Create: `worker/pipeline/retention.js`
- Modify: `worker/index.js`
- Test: `__tests__/retention.test.js`

**Interfaces:**
- Produces: `RETENTION_DAYS` (number = 14), `retentionCutoff(now = new Date(), days = RETENTION_DAYS)` (ISO string), `sweepExpiredVideos(supabase, now = new Date())` (Promise<void>).

- [ ] **Step 1: Write the failing tests**

Create `__tests__/retention.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  RETENTION_DAYS,
  retentionCutoff,
  sweepExpiredVideos,
} from "../worker/pipeline/retention.js";

describe("retentionCutoff", () => {
  it("is 14 days before the given instant", () => {
    expect(RETENTION_DAYS).toBe(14);
    expect(retentionCutoff(new Date("2026-08-27T12:00:00Z"))).toBe(
      "2026-08-13T12:00:00.000Z"
    );
  });
});

function makeSupabaseChatty(result = { error: null }) {
  const calls = [];
  const chain = {
    from: (t) => { calls.push(["from", t]); return chain; },
    update: (patch) => { calls.push(["update", patch]); return chain; },
    eq: (c, v) => { calls.push(["eq", c, v]); return chain; },
    not: (c, op, v) => { calls.push(["not", c, op, v]); return chain; },
    lt: (c, v) => { calls.push(["lt", c, v]); return result; },
  };
  return { supabase: chain, calls };
}

describe("sweepExpiredVideos", () => {
  it("marks done rows past retention as expired with nulled URLs", async () => {
    const { supabase, calls } = makeSupabaseChatty();
    const now = new Date("2026-08-27T12:00:00Z");

    await expect(sweepExpiredVideos(supabase, now)).resolves.toBeUndefined();

    expect(calls.find(([k]) => k === "from")[1]).toBe("videos");

    const update = calls.find(([k]) => k === "update")[1];
    expect(update.status).toBe("expired");
    expect(update.video_url).toBeNull();
    expect(update.thumbnail_url).toBeNull();

    expect(calls.find(([k]) => k === "eq")[2]).toBe("done");
    expect(calls.find(([k]) => k === "not")[2]).toBe("video_url");
    expect(calls.find(([k]) => k === "lt")[1]).toBe("created_at");
    expect(calls.find(([k]) => k === "lt")[2]).toBe("2026-08-13T12:00:00.000Z");
  });

  it("throws when the update fails", async () => {
    const { supabase } = makeSupabaseChatty({ error: { message: "boom" } });
    await expect(
      sweepExpiredVideos(supabase, new Date("2026-08-27T12:00:00Z"))
    ).rejects.toMatchObject({ message: "boom" });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm run test -- retention`
Expected: FAIL — `Cannot find module '../worker/pipeline/retention.js'`.

- [ ] **Step 3: Write the retention module**

Create `worker/pipeline/retention.js`:

```js
/** How long a render's files live before deletion (matches the R2 rule). */
export const RETENTION_DAYS = 14;

/**
 * ISO timestamp that separates "kept" from "expired"; rows created before it
 * are past retention. Object deletion itself is done by the R2 lifecycle
 * rule; this only keeps the DB + UI consistent (no dead video links).
 */
export function retentionCutoff(now = new Date(), days = RETENTION_DAYS) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Null out URLs and mark done rows as expired once they pass retention.
 * Idempotent: after the update `status='expired'` and `video_url` is NULL, so
 * rows are never matched twice. Safe to run concurrently across workers.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function sweepExpiredVideos(supabase, now = new Date()) {
  const { error } = await supabase
    .from("videos")
    .update({
      status: "expired",
      video_url: null,
      thumbnail_url: null,
      updated_at: new Date().toISOString(),
    })
    .eq("status", "done")
    .not("video_url", "is", null)
    .lt("created_at", retentionCutoff(now));
  if (error) throw error;
}
```

- [ ] **Step 4: Wire the sweep into the worker loop**

In `worker/index.js`, add the import near the top:

```js
import { sweepExpiredVideos } from "./pipeline/retention.js";
```

Add a constant next to the other knobs (near lines 37–42):

```js
/** Run the retention sweep at most this often. */
const RETENTION_SWEEP_MS = Number(process.env.RETENTION_SWEEP_MS || 15 * 60 * 1000);
```

Replace the `main()` loop body (lines 310–334) with:

```js
async function main() {
  const supabase = getSupabase();
  console.log(
    JSON.stringify({
      event: "worker_start",
      worker_id: WORKER_ID,
      stub: STUB_RENDER,
      lease_seconds: LEASE_SECONDS,
    })
  );

  let lastSweep = 0;
  for (;;) {
    try {
      if (Date.now() - lastSweep >= RETENTION_SWEEP_MS) {
        await sweepExpiredVideos(supabase);
        lastSweep = Date.now();
      }
      const job = await claimJob(supabase);
      if (!job?.id) {
        await sleep(POLL_MS);
        continue;
      }
      await processJob(supabase, job);
    } catch (err) {
      // A sweep error must not kill the claim loop.
      console.error("worker loop error:", err);
      await sleep(5000);
    }
  }
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npm run test -- retention`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add worker/pipeline/retention.js worker/index.js __tests__/retention.test.js
git commit -m "feat(worker): mark render rows expired after 14-day retention"
```

---

### Task 4: Env docs + expired-state UI label

**Files:**
- Modify: `worker/.env.example`, `worker/README.md`, `src/components/CreatorWorkspace.js`

- [ ] **Step 1: Add R2 + retention env to `worker/.env.example`**

Append after the existing `RENDERS_BUCKET=renders` line:

```bash
# Object storage backend: "supabase" (default) or "r2"
# STORAGE_BACKEND=supabase
# R2 settings (only needed when STORAGE_BACKEND=r2)
# R2_ACCOUNT_ID=
# R2_ACCESS_KEY_ID=
# R2_SECRET_ACCESS_KEY=
# R2_BUCKET=shortclips-renders
# R2_PUBLIC_BASE_URL=https://cdn.example.com
# Retention sweep cadence (default 15 min)
# RETENTION_SWEEP_MS=900000
```

- [ ] **Step 2: Document the new env in `worker/README.md`**

In the env table (after the `RENDERS_BUCKET` row) add:

```
| `STORAGE_BACKEND` | no | `r2` (prod) or unset/`supabase` (local). See "Object storage" below. |
| `R2_ACCOUNT_ID` | if r2 | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | if r2 | R2 API token access key (Object Read & Write) |
| `R2_SECRET_ACCESS_KEY` | if r2 | R2 API token secret |
| `R2_BUCKET` | no | Default `shortclips-renders` |
| `R2_PUBLIC_BASE_URL` | if r2 | Custom domain serving the bucket, e.g. `https://cdn.example.com` |
| `RETENTION_SWEEP_MS` | no | DB expiry sweep cadence (default `900000` = 15 min) |
```

Add a short "Object storage" section after the "Env" section:

```markdown
## Object storage

Rendered MP4s + thumbnails go to Cloudflare R2 in production (`STORAGE_BACKEND=r2`),
and to Supabase Storage `renders` locally (default). Files are capped at **100 MB**;
an over-limit render fails and its credit is refunded. R2's **lifecycle rule** deletes
each object 14 days after upload; the worker sweep nulls the matching `videos` row so
no dead links appear. Create the bucket, custom domain, lifecycle rule, and API token
in the Cloudflare dashboard (see `docs/superpowers/plans/2026-08-27-r2-storage-retention.md`,
Task 5).
```

- [ ] **Step 3: Label the `expired` status in the UI**

In `src/components/CreatorWorkspace.js`, `formatStatus` (around line 65), add a branch:

```js
function formatStatus(status, progress) {
  if (!status) return "Unknown";
  if (status === "done") return "Ready";
  if (status === "failed") return "Failed";
  if (status === "expired") return "Expired";
  if (status === "running" || status === "claimed") {
    if (progress && progress !== "rendering") return progress;
    return "Rendering…";
  }
  if (status === "pending" || status === "queued") return "Queued";
  return status;
}
```

Note: expired rows have `video_url`/`thumbnail_url` nulled, so the existing guards in the render list (lines 1232/1240/1330/1354) already stop showing a video/download link; this branch only makes the status read nicely.

- [ ] **Step 4: Verify nothing regressed**

Run: `npm run test -- creator-workspace`
Expected: PASS — the surrounding component behavior is unchanged.

Or, if `creator-workspace` has no matching test file, run the full suite:

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/.env.example worker/README.md src/components/CreatorWorkspace.js
git commit -m "docs+ui: document R2/retention env and label expired renders"
```

---

### Task 5: Infrastructure setup + end-to-end verification

This task is manual (Cloudflare dashboard) plus verification commands. No committed code.

- [ ] **Step 1: Create the R2 bucket**

Cloudflare dashboard → **R2** → **Create bucket** → name `shortclips-renders`, default location.

- [ ] **Step 2: Attach a custom domain**

Bucket → **Settings** → **Public access** → **Custom domain** → add `cdn.<yourdomain>.com`. Cloudflare creates the DNS record automatically. Confirm the bucket is reachable at `https://cdn.<yourdomain>.com/`. Set `R2_PUBLIC_BASE_URL=https://cdn.<yourdomain>.com` (no trailing slash).

- [ ] **Step 3: Add the 14-day lifecycle rule**

Bucket → **Settings** → **Lifecycle rules** → **Create rule**: name `expire-after-14d`, **Delete** action, condition **Age = 14 days** (empty prefix, all objects). This is the deletion guarantee — the worker sweep only keeps the DB consistent and can lag without risk of orphaned objects.

- [ ] **Step 4: Create an R2 API token**

**R2** → **Manage R2 API Tokens** → **Create API token**: **Object Read & Write**, scope the `shortclips-renders` bucket. Record **Account ID**, **Access Key ID**, **Secret Access Key** (secret shown once).

- [ ] **Step 5: Set prod env**

Add to `/etc/shortclips-worker.env` (see `worker/README.md` deployment notes):

```
STORAGE_BACKEND=r2
R2_ACCOUNT_ID=<account id>
R2_ACCESS_KEY_ID=<access key id>
R2_SECRET_ACCESS_KEY=<secret>
R2_BUCKET=shortclips-renders
R2_PUBLIC_BASE_URL=https://cdn.<yourdomain>.com
```

Restart the service: `sudo systemctl restart shortclips-worker`.

- [ ] **Step 6: Run the full unit suite**

Run: `npm run test`
Expected: PASS — including the new `r2-storage`, `upload-artifacts`, and `retention` files.

- [ ] **Step 7: Smoke test an R2 upload**

With a local worker pointed at R2 (`STORAGE_BACKEND=r2` + valid R2 vars in `worker/.env`, `STUB_RENDER=1`):

Run: `npm run worker:dev`
Expected: a claimed stub job logs `job_done`; enqueue a real test job and confirm the resulting `videos.video_url` is `https://cdn.<yourdomain>.com/<user_id>/<video_id>.mp4`, not a Supabase Storage URL. Fetch the URL and expect HTTP 200 with `Content-Type: video/mp4` and byte-range support (needed for browser seeking).

- [ ] **Step 8: Verify the 100MB cap**

Temporarily override the constant check locally, or render a known-large test clip, and confirm the worker fails the job with an `Upload exceeds 100 MB limit` error, the job reaches terminal `failed` (not retried), and the credit is refunded via the refund logs.

- [ ] **Step 9: Verify the retention sweep**

Point a worker at a staging DB, set one `videos` row to `status='done'`, `video_url` non-null, and `created_at` = 15 days ago:

```sql
update public.videos
   set status = 'done',
       video_url = 'https://cdn.example.com/u/test.mp4',
       created_at = now() - interval '15 days'
 where id = '<some-id>';
```

Confirm within 15 minutes the row becomes `status='expired'` with null `video_url`/`thumbnail_url`; confirm the R2 object is gone (or will be within 24h of the lifecycle rule firing).

---

## Self-Review

- **Spec coverage:** R2 upload ✓ (Task 1–2), 100MB cap ✓ (Task 1 `assertUploadSize` + Task 2 wiring), custom domain ✓ (Task 5 Step 2 + `R2_PUBLIC_BASE_URL`), 14-day retention ✓ (R2 lifecycle in Task 5 Step 3 + DB sweep Task 3), no migration ✓ (Global Constraints). All five user requirements trace to a task.
- **Placeholder scan:** no TBD/TODO; every code step ships concrete code; every test step ships concrete assertions.
- **Type consistency:** `uploadFile`, `publicUrl`, `assertUploadSize`, `MAX_UPLOAD_BYTES` names are identical between `storage.js` (definition), `upload.js` (caller), and tests. `sweepExpiredVideos`/`retentionCutoff`/`RETENTION_DAYS` match between `retention.js` and `retention.test.js`. The worker-visible signature `uploadRenderArtifacts(supabase, { bucket, userId, videoId, videoPath, thumbPath })` is unchanged, so `worker/pipeline/index.js` needs no edit.
