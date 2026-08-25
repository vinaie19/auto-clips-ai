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
| `WORKER_ID` | yes | Unique per instance |
| `LEASE_SECONDS` | no | Default 180; raise to 300 for long encodes |
| `POLL_MS` | no | Default 3000 |
| `STUB_RENDER` | no | `1` = stub; otherwise real pipeline |
| `RENDERS_BUCKET` | no | Default `renders` |
| `FFMPEG_LOW_MEM` | no | `1` = segment path for small RAM; default = single-pass encode |
| `FFMPEG_THREADS` | no | FFmpeg `-threads` / `-filter_threads` (default `1`; try `2`–`3` on 4 vCPU) |
