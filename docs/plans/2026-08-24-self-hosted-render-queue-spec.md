# Spec: Self-Hosted Render Queue (Replace Shotstack)

**Status:** Draft for implementation  
**Date:** 2026-08-24  
**Repo:** autoclips-saas  
**Related plan:** [`2026-08-24-self-hosted-render-queue-plan.md`](./2026-08-24-self-hosted-render-queue-plan.md)

---

## Context

AutoClips today drafts a script, fetches Pexels clips, builds a Shotstack timeline JSON, queues a cloud render, and polls Shotstack until an MP4 URL is ready. Shotstack is paid per output minute (~$0.20–0.30/min), owns the job queue/status API, and is a hard dependency for every generate.

We want to **remove Shotstack** and run renders ourselves using:

1. A **Postgres job table** (extend `videos`) as the queue — no Redis.
2. Claim / lease / heartbeat / retry semantics inspired by Flotorch gateway’s orchestrator outbox (`FOR UPDATE SKIP LOCKED`, visibility timeout, expiry reclaim) — **without** copying the multi-node workflow graph.
3. A **separate always-on worker on AWS Lightsail** that runs TTS + FFmpeg (or Remotion later) and uploads finished MP4s. **Local/MVP:** Supabase Storage bucket `renders`. **Production:** **Cloudflare R2** (free egress; 10 GB free storage). Next.js stays on Vercel.
4. **Automatic retries** for transient failures and crash recovery.
5. **Manual user retry** after a job reaches terminal `failed`.

Stakeholders: product (margin, control of captions/render quality), eng (ops burden of a worker), users (failed clips must be recoverable).

---

## Current State (verified 2026-08-24)

| Area | Behavior | Location |
|------|----------|----------|
| Generate | Auth → credits → Pexels → LLM script → Shotstack timeline → `POST` Shotstack → insert `videos` with `status: queued` | `src/app/api/generate/route.js` |
| Status | Poll Shotstack by `render_id`; on done/failed update `videos` | `src/app/api/generate/status/route.js` |
| UI poll | Every 3s until done/failed/timeout | `src/components/CreatorWorkspace.js` |
| History | List videos by clerk user | `src/app/api/videos/route.js` |
| Credits | Deduct one free credit when render is queued (before success) | `src/lib/user-credits.js` + generate route |
| Schema | `videos`: `render_id`, `status`, `video_url`, etc. No queue/lease columns | `supabase/schema.sql` |

Shotstack features in use: multi-clip video track, rich-text captions + themes, TTS by tone, 9:16 HD 30fps ~45s MP4.

---

## Goals

- Zero Shotstack API calls in production generate/status paths.
- Same UX: Generate → poll → MP4 in history.
- Durable queue in Supabase/Postgres with crash-safe claim and retries.
- User can manually retry a finally-failed clip.
- Credits only consumed for successful renders (or refunded on final fail — see decision below).

## Non-Goals (v1)

- Full Shotstack-compatible edit DSL / white-label editor.
- Redis / BullMQ / SQS.
- Flotorch-style multi-node graphs, event sourcing, HIL signals.
- 4K, long-form, high concurrency render farm.
- Word-level caption animations parity with Shotstack (static/punchy burn-in is enough for v1).
- Running FFmpeg inside Vercel/Next serverless.

---

## Proposed Change

### Architecture

```
Browser
  │
  ├─ POST /api/generate     → script + Pexels + INSERT videos (pending) → { renderId: video.id }
  ├─ GET  /api/generate/status?id=… → SELECT videos status/url/error
  └─ POST /api/videos/:id/retry → re-queue failed row (credits check)

Render worker (always-on process on **AWS Lightsail**; Next.js stays on Vercel — not co-located for v1)
  loop: CLAIM (SKIP LOCKED) → heartbeat → TTS → download → FFmpeg → object storage upload
        → done | schedule auto-retry | failed
        (dev: Supabase Storage; prod: Cloudflare R2)
```

**Queue source of truth:** `public.videos` row (or `render_jobs` FK to `videos` if we prefer separation; default is **extend `videos`**).

**Inspiration (Flotorch gateway, do not port wholesale):**

- Claim: `FOR UPDATE SKIP LOCKED` + `next_visible_at` lease — `src/orchestrator/api/workers/index.ts`
- Heartbeat extends lease — `transition-node-to-running.ts`
- Expiry reclaim / max retries — `expiry-scanner.ts`
- **Difference:** Flotorch only auto-retries on timeout; worker-reported `NODE_FAILED` is terminal. AutoClips **must** retry transient worker errors (TTS/network/FFmpeg OOM) with backoff.

### Locked decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Queue | Postgres table, no Redis | Matches Flotorch outbox idea; already on Supabase |
| Job identity | `videos.id` is `renderId` for status URLs | Simplifies UI; drop Shotstack ids |
| Render engine (v1) | FFmpeg in a Docker/worker process | Closest cost/control fit for stitch + burn-in captions |
| TTS | **OpenAI TTS** (`tts-1`); Moody→`onyx`, Corporate→`alloy`, Cinematic→`nova` | Already use OpenAI for scripts |
| Storage | **Dev/MVP:** Supabase bucket **`renders`** (public). **Prod:** **Cloudflare R2** bucket (public via `r2.dev` or custom domain); `video_url` stores the public HTTPS URL | R2: 10 GB free + **$0 egress** — video views would burn Supabase egress quota; keep Supabase for Postgres/Auth only in prod |
| Credits | **Reserve at enqueue** (existing `deductCreditIfNeeded`, made atomic), **refund one credit on terminal `failed`**; never deduct for auto-retries; manual retry uses same `canGenerate` check and reserves again on enqueue | Blocks parallel-generate abuse while failed renders stay free via refund |
| Auto retry max | 3 attempts total (initial + 2 retries) | Align with Flotorch default `retry.max` |
| Manual retry | Allowed only when `status = failed`; resets `attempts` to 0; same row id | No duplicate history spam |
| Worker host | **AWS Lightsail** (small Linux instance) for production; local `node worker` / Docker for development | Use AWS credits; simple VM + FFmpeg; not Vercel serverless; not ECS/Fargate for v1 |
| App host | Next.js remains on **Vercel** | Worker is a separate always-on process; API/UI stay request/response |
| Worker concurrency | **1** encode at a time on the Lightsail box | Avoids CPU/memory contention on a cheap instance |

### Schema (extend `videos`)

Add (names may snake_case to match existing columns):

| Column | Type | Purpose |
|--------|------|---------|
| `status` | text | `pending` \| `claimed` \| `running` \| `done` \| `failed` (migrate off `queued`) |
| `attempts` | int | default 0 |
| `max_attempts` | int | default 3 |
| `next_visible_at` | timestamptz | claimable when null or `<= now()` |
| `claimed_by` | text | worker id |
| `claimed_at` | timestamptz | |
| `heartbeat_at` | timestamptz | |
| `expires_at` | timestamptz | optional mirror of lease end |
| `payload` | jsonb | script, pexels URLs, tone, subtitle_theme, voice |
| `error` | text | last failure message (user-safe) |
| `progress` | text | optional step label for UI |

Indexes:

- `(status, next_visible_at)` for claim
- existing user/history indexes remain

`render_id`: set equal to `id::text` on insert (or deprecate and poll by `id` only). Prefer **status URL uses `videos.id`**.

### Status machine

```
pending ──claim──► claimed/running ──success──► done
                       │
                       ├─ retryable error & attempts < max ──► pending (next_visible_at = now + backoff)
                       ├─ non-retryable or max exceeded ──► failed
                       └─ lease expired (no heartbeat) ──► claimable again (attempts++)
failed ──manual retry──► pending (attempts = 0, error = null)
```

**Claimable predicate:**

```sql
attempts < max_attempts
AND (
  status = 'pending'
  OR (status IN ('claimed', 'running') AND next_visible_at <= now())
)
```

On reclaim of expired lease, increment `attempts` in the same UPDATE. If increment would exceed max → set `failed` instead of claiming.

### Retry policy

**Retryable:** network/5xx/429 from TTS or downloads, FFmpeg OOM/transient exit, worker crash (lease expiry).

**Not retryable:** invalid/empty payload, missing env, FFmpeg binary missing, auth errors, user cancel.

**Backoff (video-scale):** `min(180s, 30s * 1.5^attempt)` after explicit failure. Lease duration while running: ~3–5 minutes, heartbeat every ~15–30s.

**Scanner (optional v1):** background interval that marks stuck `running` past `expires_at` as reclaimable; can be omitted if claim query already includes expired leases.

### API contracts

#### `POST /api/generate`

Unchanged client inputs: `topic`, `tone`, `subtitleTheme`.

Changes:

1. Still: auth, paywall (`canGenerate`), Pexels, script draft.
2. **Do not** call Shotstack.
3. Insert `videos` with `status: pending`, `payload: {…}`, `next_visible_at: now()`, `attempts: 0`.
4. **Keep** calling `deductCreditIfNeeded` here to reserve the credit, but make the decrement atomic (guarded RPC — see plan Task 7).
5. Return `{ renderId: video.id, videoId, statusUrl, script, … }`.

#### `GET /api/generate/status?id=`

1. Auth; load `videos` where `id = id` and `clerk_user_id = user`.
2. Return `{ renderId, status, url: video_url, poster: thumbnail_url, error }`.
3. Map worker statuses for UI: `pending`/`claimed` → queued messaging; `running` → rendering.

#### `POST /api/videos/[id]/retry` (new)

1. Auth; row must belong to user and `status === 'failed'`.
2. `canGenerate` check; 403 `PAYWALL_REQUIRED` if not.
3. Reset: `status=pending`, `attempts=0`, `error=null`, clear claim fields, `next_visible_at=now()`. Keep `payload` (do not re-LLM unless a later “regenerate script” feature).
4. Return same shape as generate for polling.

#### `GET /api/videos`

Include `error` (and optionally `attempts`) so history can show fail reason + Retry.

### Worker responsibilities

Separate package/folder e.g. `worker/` or `services/render-worker/`:

1. Long-poll or tight loop claim via SQL (service role).
2. Set `running`, heartbeat while working.
3. Pipeline: TTS → download clips → FFmpeg template (9:16, captions from payload themes) → upload object storage (Supabase Storage locally; **R2 in prod**) → update `video_url`, `status=done`.
4. On success: nothing credit-related (reserved at enqueue). On terminal `failed`: refund one credit for non-premium owner via `refundCreditForVideo(videoId)` in `user-credits`.
5. On failure: classify → requeue with backoff or `failed`.

**Credit refund from worker:** on terminal `failed`, use service role to increment `free_credits_remaining` by 1 for non-premium owners, idempotently (refund only when the single `claimed/running → failed` UPDATE returns a row).

### Frontend

- Remap loader text off Shotstack status names.
- History: Retry button when `status === 'failed'`.
- Disable generate/retry while a poll is in flight for that id.
- Remove Shotstack-only copy.

### Config / secrets

Remove dependency on `SHOTSTACK_API_KEY` for generate/status.

Add for worker: Supabase URL + service role (queue/DB only), TTS provider key, `WORKER_ID`, lease/backoff env knobs.

**Object storage (prod R2):** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` (custom domain or `https://pub-….r2.dev`). Optional: `STORAGE_BACKEND=supabase|r2` (default `supabase` for local; set `r2` on Lightsail).

---

## Acceptance Criteria

1. With Shotstack key unset/removed, `POST /api/generate` still queues a job and returns a UUID `renderId` that exists in `videos`.
2. A running worker claims a `pending` job via `FOR UPDATE SKIP LOCKED` and no two workers claim the same row in concurrent tests.
3. Happy path: generate → poll ≤ N minutes → `status=done` and `video_url` is a playable MP4 URL; history shows the clip. In **prod**, that URL is an **R2** (or custom-domain) HTTPS URL, not Supabase Storage.
4. Transient failure (simulated retryable error) increments `attempts`, returns to `pending` with future `next_visible_at`, and succeeds on a later attempt without charging more than one credit total for free users.
5. After `max_attempts` retryable failures, row is `failed` with non-empty `error`; the credit reserved at enqueue was **refunded**, so net charge is zero.
6. Non-retryable failure marks `failed` without exhausting all attempts unnecessarily (attempt may still increment once).
7. Killing the worker mid-job: after lease expiry another worker (or restarted worker) can reclaim; if attempts exceed max → `failed`.
8. `POST /api/videos/:id/retry` on a `failed` owned row requeues to `pending` with `attempts=0`; on success deducts one credit for free users.
9. Retry on non-failed or other user’s row returns 4xx; unauthenticated returns 401.
10. Free user with 0 credits cannot generate or manual-retry (403 `PAYWALL_REQUIRED`).
11. UI shows Retry on failed history items and polls after manual retry until done/failed.
12. No production code path calls `api.shotstack.io` after cutover.
13. Unit/integration tests for claim, backoff, retry classification, credit-on-done, and manual retry are written and passing (`npm run test`).
14. E2E or documented manual QA checklist covers generate + failed + retry (Playwright may mock worker completion if full FFmpeg e2e is too heavy).
15. A Lightsail instance runs the worker (systemd/pm2 or Docker), claims `pending` jobs against staging/prod Supabase, uploads the MP4 to **Cloudflare R2**, and completes at least one real render end-to-end with a playable R2 `video_url`.

---

## Testing Plan

| Layer | What | Count (approx) |
|-------|------|----------------|
| Unit | Claimable SQL helpers / status transitions / `isRetryableError` / backoff | +6 |
| Unit | Credit deduct only on done; no deduct on failed/retry queue | +3 |
| Integration | Insert pending → claim → complete → status API | +2 |
| Integration | Explicit retryable fail → pending → done; max attempts → failed | +2 |
| Integration | Manual retry endpoint auth + state guards | +2 |
| E2E / QA | Generate poll done; history Retry visible on failed | +2 |

---

## Rollback Plan

1. Feature flag `RENDER_BACKEND=shotstack|self` (optional) during rollout; flip back to Shotstack if worker down.
2. Hard cutover: redeploy previous release that still has Shotstack submit/status; schema additive columns are backward-compatible (old code ignores new columns).
3. Do not drop Shotstack env until self-hosted is stable for ≥1 soak period.
4. Failed-in-flight self-hosted jobs can be marked `failed` and users offered Retry after fix.

---

## Effort Estimate

| Component | Estimate |
|-----------|----------|
| Schema migration + status enums | 0.5–1d |
| Generate/status/retry API changes | 1d |
| Queue claim/heartbeat/retry helpers | 1d |
| Worker skeleton + Storage upload stub | 1d |
| Prod R2 upload (S3 API) + Lightsail env | 0.5d |
| FFmpeg template (clips + captions + TTS mux) | 2–4d |
| Credits-on-done + tests | 0.5–1d |
| Frontend poll + Retry UI | 0.5–1d |
| Deploy worker + Lightsail ops docs | 0.5–1d |
| **Total** | **~7–11d** depending on caption/TTS polish |

---

## Files Reference

| File | Change |
|------|--------|
| `supabase/schema.sql` + new migration | Queue columns on `videos` |
| `src/app/api/generate/route.js` | Remove Shotstack; insert pending + payload |
| `src/app/api/generate/status/route.js` | Read DB only |
| `src/app/api/videos/[id]/retry/route.js` | New |
| `src/app/api/videos/route.js` | Expose `error` |
| `src/lib/user-credits.js` | Keep deduct; ensure idempotent done-path |
| `src/lib/render-queue.js` (new) | Claim/complete/fail helpers if used from Next (retry) |
| `src/components/CreatorWorkspace.js` | Status map + Retry |
| `worker/` (new) | Claim loop, pipeline, FFmpeg, upload (Supabase local; **R2 prod**) |
| `worker/Dockerfile` (optional) | Same image for local + Lightsail if using Docker |
| `worker/README.md` | Local run + Lightsail deploy + **R2 env** (size, systemd/pm2, secrets) |
| `.env.local` / docs | Drop Shotstack; document worker env |
| `__tests__/*` | Queue + credits + retry |
| `TESTING.md` / README | Worker how-to |

## Out of Scope

- Remotion migration (possible v2 if caption animation becomes product-critical).
- Multi-region workers, priority queues, per-tenant concurrency SLAs.
- Regenerating script/Pexels on manual retry (reuse `payload`).
- Billing/Stripe premium flows beyond existing `is_premium` flag.
- ECS/Fargate, Fly, Railway, or bare multi-droplet farms for v1.
- Co-locating Next.js on Lightsail (keep Vercel unless we later choose to move).
- Migrating historical Supabase Storage MP4s into R2 (optional; new prod uploads go to R2 only).
- Signed/private playback URLs (v1 uses public object URLs).

## Open Questions (resolve during plan Task 0)

Resolved (2026-08-24):

- Credit policy = reserve at enqueue + refund on terminal `failed`.
- Worker host = **AWS Lightsail** (prod); local-first for development; Next stays on Vercel.
- TTS = **OpenAI TTS** (`tts-1`); voices: Moody→`onyx`, Corporate→`alloy`, Cinematic→`nova`.
- Storage = **Dev/MVP:** Supabase bucket **`renders`**, public URLs. **Prod:** **Cloudflare R2** (public base URL); Supabase Storage not used for new prod renders (egress cost).
- Rollout = **hard cut** (no `RENDER_BACKEND` dual-run flag).
- Worker language = **Node** in monorepo `worker/`.
- Lightsail = start **$10–12 / 2 GB RAM** Ubuntu LTS; concurrency 1; secrets via env file on the instance.

---

## Success Metrics

- Shotstack spend → $0 for renders.
- p95 time-to-MP4 acceptable for ~45s clips (target: document measured baseline after stub).
- Final-fail rate < X% after retries; manual retry recovery tracked in logs.
