# Spec: Self-Hosted Render Queue (Replace Shotstack)

**Status:** Draft for implementation (pricing + billing locked 2026-08-24)  
**Date:** 2026-08-24  
**Repo:** short-clips-saas  
**Related plan:** [`2026-08-24-self-hosted-render-queue-plan.md`](./2026-08-24-self-hosted-render-queue-plan.md)

---

## Context

Short Clips today drafts a script, fetches Pexels clips, builds a Shotstack timeline JSON, queues a cloud render, and polls Shotstack until an MP4 URL is ready. Shotstack is paid per output minute (~$0.20–0.30/min), owns the job queue/status API, and is a hard dependency for every generate.

We want to **remove Shotstack** and run renders ourselves using:

1. A **Postgres job table** (extend `videos`) as the queue — no Redis.
2. Claim / lease / heartbeat / retry semantics via Postgres (`FOR UPDATE SKIP LOCKED`, visibility timeout, expiry reclaim) — a simple single-job worker loop, not a multi-node workflow graph.
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
- **Paid plan without Unlimited:** subscription + optional top-up, hard monthly credit caps that match single-worker capacity and OpenAI COGS.

## Non-Goals (v1)

- Full Shotstack-compatible edit DSL / white-label editor.
- Redis / BullMQ / SQS.
- Multi-node workflow graphs, event sourcing, or human-in-the-loop signals.
- 4K, long-form, high concurrency render farm.
- Word-level caption animations parity with Shotstack (static/punchy burn-in is enough for v1).
- Running FFmpeg inside Vercel/Next serverless.
- **Unlimited / `is_premium` bypass** that skips credit deduction.
- Dynamic pay-any-amount volume formula ($1–$100 slider).
- Soft overage (per-video after cap).
- Mid-render cancel (FFmpeg/TTS abort).
- Cancel-while-queued (optional later — see Deferred).
- Higher packs beyond Creator ($15/60) — e.g. $29/90 — until demand justifies them.

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

**Queue claim pattern:**

- Claim: `FOR UPDATE SKIP LOCKED` + `next_visible_at` lease
- Heartbeat extends the lease while the worker runs
- Expiry reclaim / max retries for crashed workers
- Auto-retry **transient** worker errors (TTS/network/FFmpeg OOM) with backoff — not only lease timeouts

### Locked decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Queue | Postgres table, no Redis | Already on Supabase; simple claim loop |
| Job identity | `videos.id` is `renderId` for status URLs | Simplifies UI; drop Shotstack ids |
| Render engine (v1) | FFmpeg in a Docker/worker process | Closest cost/control fit for stitch + burn-in captions |
| TTS | **OpenAI TTS** (`tts-1`); Moody→`onyx`, Corporate→`alloy`, Cinematic→`nova` | Already use OpenAI for scripts |
| Storage | **Dev/MVP:** Supabase bucket **`renders`** (public). **Prod:** **Cloudflare R2** bucket (public via `r2.dev` or custom domain); `video_url` stores the public HTTPS URL | R2: 10 GB free + **$0 egress** — video views would burn Supabase egress quota; keep Supabase for Postgres/Auth only in prod |
| Credits | **Every generate deducts 1 credit** (free and paid). **Reserve at enqueue** (atomic), **refund one credit on terminal `failed`**; never deduct for auto-retries; manual retry uses same `canGenerate` and reserves again on enqueue | No Unlimited bypass; failed renders stay free via refund |
| Pricing (v1) | **Free: 3** once. **Starter $5 → 15 credits**. **Creator $15 → 60 credits**. Each sold as **monthly subscription** and **one-time top-up** (Starter ~3/$; Creator ~4/$). Fallback: Starter allotment 15→20 at same $5 if conversion weak | Better rate on Creator drives upsell; Creator covers “want more” without Unlimited |
| Billing | **Paddle** (MoR): Starter/Creator sub + top-up; webhook grants 15 or 60 by price id | LemonSqueezy blocked for individuals in some regions; app uses Paddle overlay + `/api/webhooks/paddle` |
| B-roll matching | **Line-bound beats** (4–15) + **gpt-4o-mini vision verify** on Pexels still; **1 re-query + re-fetch** on mismatch; fall back to first clip if retry fails. Video length follows TTS (script word count + mild atempo fit), not clip count. | Stock search alone often mismatches narration; verify closes the gap without blocking generate |
| Paid credit grant | Sub payment/renewal or top-up order → `credits +=` pack size (15 or 60). **No `is_premium` skip of deduct** | Metered credits for everyone |
| Renewal rule | Prefer **add pack size on successful subscription payment** (leftover rolls). Alternative: reset unused to pack size if abuse appears | Friendlier default; hard cap = current balance only |
| Auto retry max | 3 attempts total (initial + 2 retries) | Enough for transient TTS/network/FFmpeg failures |
| Manual retry | Allowed only when `status = failed`; resets `attempts` to 0; same row id | No duplicate history spam |
| Worker host | **AWS Lightsail** (small Linux instance) for production; local `node worker` / Docker for development | Use AWS credits; simple VM + FFmpeg; not Vercel serverless; not ECS/Fargate for v1 |
| App host | Next.js remains on **Vercel** | Worker is a separate always-on process; API/UI stay request/response |
| Worker concurrency | **1 process / 1 encode** on ~1–2 GB Lightsail. Scale later: bigger instance → 2–3 processes (unique `WORKER_ID`) → more boxes. Do **not** start at 5 workers on a small VM | FFmpeg 1080×1920 is CPU/RAM-bound; parallel encodes OOM/thrash cheap instances |
| Deploy / env upgrade | Jobs live in Postgres. Prefer drain then restart. In-flight `running` recovers via **lease expiry + reclaim** (may retry; attempts++). Optional later: graceful SIGTERM (finish current job, stop claiming) | Prevents “lost” queue items when upgrading server/env |
| Cancel | **Not in v1.** Optional later: cancel only `pending` + refund. No mid-render cancel | Queue cancel is easy; aborting TTS/FFmpeg is not |

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

1. Still: auth, paywall (`canGenerate`), filmable script draft, **line-bound visual plan**, Pexels fetch with **vision clip-verify + 1 retry**.
2. Enqueue `videos` with `payload` including `script`, `visualBeats` (`line`, `query`, `url`, `weight`, `verified`, `retried`), tone/voice/captions.
3. **Do not** call Shotstack.
4. Insert `videos` with `status: pending`, `payload: {…}`, `next_visible_at: now()`, `attempts: 0`.
5. **Keep** calling `deductCreditIfNeeded` here to reserve the credit, but make the decrement atomic (guarded RPC — see plan Task 7).
6. Return `{ renderId: video.id, videoId, statusUrl, script, … }`.

#### Clip verify + 1 retry (generate path)

After each Pexels pick for a spoken line:

1. Take the Pexels still (`video.image` or first `video_pictures` URL) — not a full video download.
2. Call **gpt-4o-mini** vision: score 0–1 whether the still matches the **spoken line** (threshold **0.55**).
3. If match (or no still / API failure / `CLIP_VERIFY=0`): keep the clip.
4. If mismatch: use model `betterQuery` (or a short fallback from the line) → **one** re-search → prefer a different URL.
5. If retry finds nothing better: **keep the original clip** (never block generate for verify).
6. Persist `verified` / `retried` on each beat in `payload.visualBeats`.

Modules: `src/lib/clip-verify.js`, `src/lib/pexels-broll.js` (`resolveVerifiedClip`).

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
4. On success: nothing credit-related (reserved at enqueue). On terminal `failed`: refund one credit for the owner via `refundCreditForFailedJob` (all users — free and paid — use the same credit balance).
5. On failure: classify → requeue with backoff or `failed`.

**Credit refund from worker:** on terminal `failed`, use service role to increment `free_credits_remaining` (or renamed `credits_remaining`) by 1, idempotently (refund only when the `credit_refunded` mark succeeds). **Do not skip refund based on `is_premium`.**

### Frontend

- Remap loader text off Shotstack status names.
- History: Retry button when `status === 'failed'`.
- Disable generate/retry while a poll is in flight for that id.
- Remove Shotstack-only copy.
- **Pricing UI:** replace “Go Unlimited — $29/mo” with **Starter $5 · 15** and **Creator $15 · 60** (subscribe + top-up CTAs) on the paywall and landing `#pricing` section.
- Show remaining credits for all users (including subscribers); never imply unlimited.

### Pricing & billing (LemonSqueezy)

**Products (4 SKUs)**

| SKU | Type | Price | Credits |
|-----|------|-------|---------|
| Starter | Subscription (monthly) | $5 | +15 on each successful payment / renewal |
| Creator | Subscription (monthly) | $15 | +60 on each successful payment / renewal |
| Top-up Starter | One-time | $5 | +15 immediately |
| Top-up Creator | One-time | $15 | +60 immediately |

**Paywall when credits = 0**

1. Subscribe: Starter ($5/mo · 15) or Creator ($15/mo · 60)
2. Or top-up: +15 for $5 / +60 for $15

**User / schema implications (additive)**

- Keep `free_credits_remaining` as the single spendable balance (or rename to `credits_remaining` in a migration — optional).
- Stop treating `is_premium=true` as “skip deduct.” Either deprecate the flag or repurpose it to mean “has active paid subscription” for UI only — **generate/retry always require `credits_remaining > 0`**.
- Store Lemon subscription id / customer id / plan (`starter` \| `creator`) on `users` when convenient for support and cancel webhooks.
- Webhook route (e.g. `POST /api/webhooks/lemonsqueezy`): verify signature; map **variant/product id → credit amount** (15 or 60); on subscription payment success or paid one-time order → grant that amount; on subscription cancelled → keep remaining credits, stop future renewals.
- Checkout must pass Clerk user id (custom field) or matchable email so grants land on the right `users` row.

**Capacity note:** Starter (15/mo) is the default safe load for one Lightsail worker. Creator (60/mo) is OK if few subscribers; do not sell Unlimited. Next upsell later: e.g. $29/90 — not in v1.

### Ops: worker upgrades without dropped jobs

| Job state | On worker kill / restart / env change |
|-----------|----------------------------------------|
| `pending` | Untouched; next claim picks it up |
| `running` | Lease expires → reclaimable (`attempts++`); may re-run TTS/FFmpeg |
| `done` / `failed` | Terminal |

**Procedure:** edit env → `systemctl stop` (or wait for idle) → deploy → start. Prefer finishing in-flight work when possible. Overlap old+new workers briefly is OK if each has a unique `WORKER_ID`.

### Config / secrets

Remove dependency on `SHOTSTACK_API_KEY` for generate/status.

Add for worker: Supabase URL + service role (queue/DB only), TTS provider key, `WORKER_ID`, lease/backoff env knobs.

**Object storage (prod R2):** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` (custom domain or `https://pub-….r2.dev`). Optional: `STORAGE_BACKEND=supabase|r2` (default `supabase` for local; set `r2` on Lightsail).

**Billing:** LemonSqueezy webhook secret + checkout URLs (or variant ids) for all **4** SKUs — Starter/Creator sub + Starter/Creator top-up (replace placeholder Unlimited URL in `CreatorWorkspace.js` / `LandingPage.js`).

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
10. User with 0 credits cannot generate or manual-retry (403 `PAYWALL_REQUIRED`), including subscribed users who exhausted their allotment.
11. UI shows Retry on failed history items and polls after manual retry until done/failed.
12. No production code path calls `api.shotstack.io` after cutover.
13. Unit/integration tests for claim, backoff, retry classification, credit-on-done, and manual retry are written and passing (`npm run test`).
14. E2E or documented manual QA checklist covers generate + failed + retry (Playwright may mock worker completion if full FFmpeg e2e is too heavy).
15. A Lightsail instance runs the worker (systemd/pm2 or Docker), claims `pending` jobs against staging/prod Supabase, uploads the MP4 to **Cloudflare R2**, and completes at least one real render end-to-end with a playable R2 `video_url`.
16. Landing + paywall advertise **Starter $5 · 15** and **Creator $15 · 60** (subscribe + top-up); no “Unlimited” messaging.
17. Paddle webhook (or documented manual grant path for staging) adds **15 or 60** credits by purchased price id; generate still decrements for those users.
18. `is_premium` (if still present) does **not** bypass credit deduction.
19. Generate B-roll: each beat is vision-checked (gpt-4o-mini) against the spoken line; mismatch triggers at most **one** re-query + re-fetch; payload beats include `verified` / `retried`; verify failures never block enqueue.

---

## Testing Plan

| Layer | What | Count (approx) |
|-------|------|----------------|
| Unit | Claimable SQL helpers / status transitions / `isRetryableError` / backoff | +6 |
| Unit | Clip verify verdict parse + Pexels preview image pick | +4 |
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
| LemonSqueezy Starter + Creator (sub + top-up) + webhook + copy | 1–1.5d |
| Deploy worker + Lightsail ops docs | 0.5–1d |
| **Total** | **~8–12.5d** depending on caption/TTS polish + billing |

---

## Files Reference

| File | Change |
|------|--------|
| `supabase/schema.sql` + new migration | Queue columns on `videos` |
| `src/app/api/generate/route.js` | Remove Shotstack; insert pending + payload |
| `src/app/api/generate/status/route.js` | Read DB only |
| `src/app/api/videos/[id]/retry/route.js` | New |
| `src/app/api/videos/route.js` | Expose `error` |
| `src/lib/user-credits.js` | Atomic reserve/refund for **all** users; no premium bypass |
| `src/lib/render-queue.js` (new) | Claim/complete/fail helpers if used from Next (retry) |
| `src/app/api/webhooks/lemonsqueezy/route.js` (new) | Grant +15 or +60 by variant on sub payment / top-up |
| `src/components/CreatorWorkspace.js` | Status map + Retry + Starter/Creator subscribe + top-up paywall |
| `src/components/LandingPage.js` | Pricing: $5·15 and $15·60 |
| `worker/` (new) | Claim loop, pipeline, FFmpeg, upload (Supabase local; **R2 prod**) |
| `worker/Dockerfile` (optional) | Same image for local + Lightsail if using Docker |
| `worker/README.md` | Local run + Lightsail deploy + **R2 env** + concurrency 1 + upgrade/drain notes |
| `.env.local` / docs | Drop Shotstack; document worker + Lemon webhook env |
| `__tests__/*` | Queue + credits + retry + billing grant helpers |
| `TESTING.md` / README | Worker how-to |

## Out of Scope

- Remotion migration (possible v2 if caption animation becomes product-critical).
- Multi-region workers, priority queues, per-tenant concurrency SLAs.
- Regenerating script/Pexels on manual retry (reuse `payload`).
- Stripe (LemonSqueezy only for v1 billing).
- Dynamic $1–$100 credit calculator / pay-what-you-want packs.
- Soft overage billing after monthly cap.
- Mid-render cancel; cancel-while-queued (deferred — see below).
- Packs above Creator ($29/90 etc.).
- Running 5+ FFmpeg workers on a 1–2 GB Lightsail.
- ECS/Fargate, Fly, Railway, or bare multi-droplet farms for v1.
- Co-locating Next.js on Lightsail (keep Vercel unless we later choose to move).
- Migrating historical Supabase Storage MP4s into R2 (optional; new prod uploads go to R2 only).
- Signed/private playback URLs (v1 uses public object URLs).

## Deferred (explicit later)

| Item | When |
|------|------|
| Cancel while `pending` + credit refund | Users complain about queue wait / wrong topic |
| Graceful worker shutdown (finish current job on SIGTERM) | Ops pain on deploys |
| Starter allotment 15 → 20 at same $5 | Conversion too weak after a real test window |
| Pack above Creator (e.g. $29/90) | Creator subscribers still top up heavily |
| 2–3 worker processes on larger Lightsail | Sustained queue depth / p95 wait too high |

## Open Questions (resolve during plan Task 0)

Resolved (2026-08-24):

- Credit policy = reserve at enqueue + refund on terminal `failed`.
- Worker host = **AWS Lightsail** (prod); local-first for development; Next stays on Vercel.
- TTS = **OpenAI TTS** (`tts-1`); voices: Moody→`onyx`, Corporate→`alloy`, Cinematic→`nova`.
- Storage = **Dev/MVP:** Supabase bucket **`renders`**, public URLs. **Prod:** **Cloudflare R2** (public base URL); Supabase Storage not used for new prod renders (egress cost).
- Rollout = **hard cut** (no `RENDER_BACKEND` dual-run flag).
- Worker language = **Node** in monorepo `worker/`.
- Lightsail = start **$10–12 / 2 GB RAM** Ubuntu LTS; **concurrency 1**; secrets via env file on the instance.
- **Pricing = Free 3; Starter $5·15; Creator $15·60; each as monthly sub + one-time top-up; no Unlimited; LemonSqueezy.**
- **Paid users always deduct credits** (retire Unlimited / deduct bypass).
- **Cancel = not v1.**

---

## Success Metrics

- Shotstack spend → $0 for renders.
- p95 time-to-MP4 acceptable for ~45s clips (target: document measured baseline after stub).
- Final-fail rate < X% after retries; manual retry recovery tracked in logs.
- Starter vs Creator checkout mix from paywall; credit exhaustion → top-up or renew (track in Lemon).
- OpenAI TTS+script spend stays well below revenue at Starter ~3/$ and Creator ~4/$ (15 or 60 renders per paid pack).
