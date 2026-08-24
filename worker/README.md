# AutoClips render worker

Always-on claim loop: TTS (OpenAI) → download Pexels clips → FFmpeg 9:16 + captions → Supabase Storage.

## Local

```bash
cd worker
cp .env.example .env
# Set SUPABASE_* ; OPENAI_API_KEY can live in worker/.env or ../.env.local
npm install
# STUB_RENDER=0 (default) runs the real pipeline via ffmpeg-static
npm run dev
```

Also run the Next app (`npm run dev` in repo root). Generate a clip; worker logs `step_tts` → `step_download` → `step_ffmpeg` → `step_upload` → `job_done`.

### Storage bucket

Create a **public** bucket named `renders` in Supabase Storage (Dashboard → Storage → New bucket → public).

### Stub mode

`STUB_RENDER=1` skips FFmpeg and writes a sample URL (queue-only testing).

## Lightsail (production)

1. Ubuntu LTS, **~2 GB RAM**, SSH only.
2. Node 20+, clone/`rsync` `worker/`, `npm ci --omit=dev`.
3. Env in `/etc/autoclips-worker.env` (include `OPENAI_API_KEY`, `STUB_RENDER=0`).
4. systemd unit: `deploy/autoclips-worker.service`.
5. Or build/run `Dockerfile` (bundles `ffmpeg-static`).

## Env

| Variable | Required | Notes |
|----------|----------|--------|
| `SUPABASE_URL` | yes | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role |
| `OPENAI_API_KEY` | yes (real render) | TTS |
| `WORKER_ID` | yes | Unique per instance |
| `LEASE_SECONDS` | no | Default 180; raise to 300 for long encodes |
| `POLL_MS` | no | Default 3000 |
| `STUB_RENDER` | no | `1` = stub; otherwise real pipeline |
| `RENDERS_BUCKET` | no | Default `renders` |
