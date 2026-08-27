# Short Clips render worker

Always-on claim loop: **prepare** (script + Pexels/vision) → TTS → download clips → FFmpeg 9:16 + captions → Supabase Storage.

## Local

```bash
cd worker
cp .env.example .env
# Set SUPABASE_*, OPENAI_API_KEY, PEXELS_API_KEY (or rely on ../.env.local)
npm install
# STUB_RENDER=0 (default) runs the real pipeline via ffmpeg-static
npm run dev
```

Also run the Next app (`npm run dev` in repo root). Generate a clip; worker logs `step_prepare` → `step_tts` → `step_download` → `step_ffmpeg` → `step_upload` → `job_done`.

`POST /api/generate` only enqueues (topic + settings). Script and B-roll run on the worker so Vercel timeouts cannot kill prep mid-flight.

### Storage bucket

Create a **public** bucket named `renders` in Supabase Storage (Dashboard → Storage → New bucket → public).

### Stub mode

`STUB_RENDER=1` skips FFmpeg and writes a sample URL (queue-only testing).

## Lightsail (production)

1. Ubuntu LTS, **≥2 GB RAM** (1 GB OOMs on multi-clip 1080p encodes), SSH only.
2. Node 20+, clone/`rsync` `worker/`, `npm ci --omit=dev`.
3. Env in `/etc/shortclips-worker.env` (include `OPENAI_API_KEY`, `STUB_RENDER=0`).
4. systemd unit: `deploy/shortclips-worker.service` (includes MemoryHigh/Max).
5. Or build/run `Dockerfile` (bundles `ffmpeg-static`).

Render defaults to a **single** FFmpeg pass (scale → concat → ASS → one libx264 encode).
On ~1–2 GB hosts set `FFMPEG_LOW_MEM=1` to encode one clip at a time (avoids OOM; captions then re-encode after concat).

## Env

| Variable | Required | Notes |
|----------|----------|--------|
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role |
| `OPENAI_API_KEY` | yes (real render) | TTS + script + vision verify |
| `PEXELS_API_KEY` | yes (real render) | B-roll search (prepare stage) |
| `BROLL_CONCURRENCY` | no | Parallel Pexels/vision beats (default `3`, max `8`) |
| `WORKER_ID` | yes | Unique per instance |
| `LEASE_SECONDS` | no | Default 180; raise to 300 for long encodes |
| `POLL_MS` | no | Default 3000 |
| `STUB_RENDER` | no | `1` = stub; otherwise real pipeline |
| `RENDERS_BUCKET` | no | Default `renders` |
| `STORAGE_BACKEND` | no | `r2` (prod) or unset/`supabase` (local). See "Object storage" below. |
| `R2_ACCOUNT_ID` | if r2 | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | if r2 | R2 API token access key (Object Read & Write) |
| `R2_SECRET_ACCESS_KEY` | if r2 | R2 API token secret |
| `R2_BUCKET` | no | Default `shortclips-renders` |
| `R2_PUBLIC_BASE_URL` | if r2 | Custom domain serving the bucket, e.g. `https://cdn.example.com` |
| `RETENTION_SWEEP_MS` | no | DB expiry sweep cadence (default `900000` = 15 min) |
| `FFMPEG_LOW_MEM` | no | `1` = segment path for small RAM; default = single-pass encode |
| `FFMPEG_THREADS` | no | FFmpeg `-threads` / `-filter_threads` (default `1`; try `2`–`3` on 4 vCPU) |

## Object storage

Rendered MP4s + thumbnails go to Cloudflare R2 in production (`STORAGE_BACKEND=r2`),
and to Supabase Storage `renders` locally (default). Files are capped at **100 MB**;
an over-limit render fails and its credit is refunded. R2's **lifecycle rule** deletes
each object 14 days after upload; the worker sweep nulls the matching `videos` row so
no dead links appear. Create the bucket, custom domain, lifecycle rule, and API token
in the Cloudflare dashboard (see `docs/superpowers/plans/2026-08-27-r2-storage-retention.md`,
Task 5).
