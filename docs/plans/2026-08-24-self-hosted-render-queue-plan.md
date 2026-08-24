# Self-Hosted Render Queue — Implementation Plan

> **For Claude:** Implement task-by-task. Do not skip tests. Spec is source of truth for behavior.

**Goal:** Replace Shotstack with a Postgres-backed render queue, always-on FFmpeg worker, automatic retries, and manual user retry — matching [`2026-08-24-self-hosted-render-queue-spec.md`](./2026-08-24-self-hosted-render-queue-spec.md). Also ship **metered LemonSqueezy billing** (no Unlimited): Free 3 → **Starter $5 · 15** and **Creator $15 · 60** (each as monthly sub + one-time top-up).

**Architecture:** Next.js owns auth, credits gates, script/Pexels, enqueue, status, manual retry, Lemon webhooks. Worker owns claim/lease/TTS/FFmpeg/object-storage upload/`done`. Queue = extended `videos` table. No Redis. No Flotorch multi-node graph.

**Tech stack:** Next.js 16 (Vercel), Supabase (Postgres + Auth; Storage for local/MVP only), **Cloudflare R2** for prod render MP4s, Clerk, **LemonSqueezy**, FFmpeg worker on **AWS Lightsail**, Vitest, Playwright (as needed).

**Spec:** `docs/plans/2026-08-24-self-hosted-render-queue-spec.md`

**Worker hosting (locked):** Develop with local `node worker` / Docker. Ship production as an always-on process on a small **AWS Lightsail** Linux instance (Node + FFmpeg, **concurrency 1**). Scale later by upsizing the box, then adding processes with unique `WORKER_ID` — do not run 5 encodes on a 1–2 GB VM. Next.js stays on Vercel. Not ECS/Fargate for v1.

**Object storage (locked):** Local/MVP uploads to Supabase bucket `renders`. **Production uploads to Cloudflare R2** (10 GB free storage, **$0 egress**). App only stores the resulting public `video_url` string — no UI change when switching backends.

**Pricing (locked 2026-08-24):**

| Plan | Type | Price | Credits |
|------|------|-------|---------|
| Free | One-time grant | $0 | 3 |
| Starter | Monthly subscription | $5 | +15 per payment/renewal |
| Creator | Monthly subscription | $15 | +60 per payment/renewal |
| Top-up Starter | One-time | $5 | +15 |
| Top-up Creator | One-time | $15 | +60 |

- **Starter ~3 videos/$**; **Creator ~4 videos/$** (60 for $15) to incentivize the higher pack.
- **No Unlimited.** Every generate deducts 1 credit (paid and free).
- Refund 1 credit on terminal `failed` for everyone.
- Fallback experiment later: Starter 15→20 at same $5 if conversion is weak (do not cut price).
- Cancel-while-queued / mid-render cancel: **not in this plan** (deferred in spec).

---

### Task 0: Lock open questions

**Files:** update spec “Open Questions” section after decisions.

**Step 1:** Choose TTS provider and map `Moody | Corporate | Cinematic` → voice ids.

**Step 2:** Storage — local Supabase bucket `renders` (public); **prod = Cloudflare R2** (public base URL). Document env split (`STORAGE_BACKEND`).

**Step 3:** Choose rollout: hard cut vs `RENDER_BACKEND=shotstack|self` flag (recommend **hard cut** if traffic is low; flag if you need soak).

**Step 4:** Confirm worker as Node in `worker/` at repo root.

**Step 5:** Worker host is already locked (**AWS Lightsail**). Pick plan size (start 1–2 GB), region near users/Supabase, and how secrets are stored on the instance.

**Step 6 (done):** Pricing = Free 3 / Starter $5·15 / Creator $15·60 (sub + top-up each); LemonSqueezy; no Unlimited; concurrency 1.

**Done when:** Spec open questions answered; Lightsail size/region noted in worker README; pricing locked in spec.

---

### Task 1: Schema migration — queue columns on `videos`

**Files:**

- Modify: `supabase/schema.sql`
- Create: `supabase/migrations/YYYYMMDDHHMMSS_render_queue.sql`

**Step 1: Write migration**

```sql
alter table public.videos
  add column if not exists attempts integer not null default 0,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists next_visible_at timestamptz,
  add column if not exists claimed_by text,
  add column if not exists claimed_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists error text,
  add column if not exists progress text;

-- Normalize status vocabulary (pending|claimed|running|done|failed)
update public.videos set status = 'pending' where status = 'queued';
update public.videos set status = 'done' where status in ('done', 'ready');
-- leave other legacy values; new code writes only the enum above

create index if not exists videos_claim_idx
  on public.videos (status, next_visible_at);

comment on column public.videos.payload is 'Render inputs: script, pexelsUrls, tone, subtitleTheme, voice';
```

**Step 2:** Mirror changes in `supabase/schema.sql` for greenfield setups.

**Step 3:** Apply migration to linked Supabase project (CLI or SQL editor).

**Done when:** New columns exist; claim index present; old `queued` rows migrated to `pending` if any.

---

### Task 2: Shared queue helpers (claim / fail / complete / requeue)

**Files:**

- Create: `src/lib/render-queue.js`
- Create: `__tests__/render-queue.test.js`

**Step 1: Implement pure helpers**

- `isRetryableError(err)` — classify by code/message/status
- `computeBackoffSeconds(attempt)` — `Math.min(180, Math.round(30 * 1.5 ** attempt))`
- `LEASE_SECONDS` default 180–300

**Step 2: Implement DB operations via `getSupabaseAdmin()`**

Note: Supabase JS may not expose `FOR UPDATE SKIP LOCKED` cleanly. Prefer a **Postgres RPC**:

```sql
-- migration companion
create or replace function public.claim_render_job(p_worker_id text, p_lease_seconds int default 180)
returns public.videos
language plpgsql
security definer
as $$
declare
  job public.videos;
begin
  select * into job
  from public.videos
  where attempts < max_attempts
    and (
      status = 'pending'
      or (status in ('claimed', 'running') and next_visible_at is not null and next_visible_at <= now())
    )
  order by created_at asc
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  -- reclaim path counts as an attempt when previously claimed/running
  if job.status in ('claimed', 'running') then
    if job.attempts + 1 >= job.max_attempts then
      update public.videos
      set status = 'failed',
          error = coalesce(error, 'max retries exceeded'),
          claimed_by = null,
          updated_at = now()
      where id = job.id
      returning * into job;
      return null; -- or return failed row; worker should skip
    end if;
  end if;

  update public.videos
  set status = 'claimed',
      claimed_by = p_worker_id,
      claimed_at = now(),
      heartbeat_at = now(),
      next_visible_at = now() + make_interval(secs => p_lease_seconds),
      expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = case
        when job.status in ('claimed', 'running') then job.attempts + 1
        else job.attempts
      end,
      updated_at = now()
  where id = job.id
  returning * into job;

  return job;
end;
$$;
```

Refine edge cases in implementation (first claim should not burn an attempt; only reclaim/explicit fail increments — match spec).

Also implement:

- `heartbeatJob(id, workerId, leaseSeconds)`
- `completeJob(id, { videoUrl, thumbnailUrl })` — set `done`, clear claim fields
- `failJob(id, { error, retryable })` — either requeue with backoff + `attempts+1` or terminal `failed`
- `manualRequeue(id)` — reset for user retry (called from API after auth)

**Step 3: Unit tests** for backoff, retryable classifier, and mocked complete/fail transitions.

**Done when:** `npm run test` covers helpers; RPC exists in DB.

---

### Task 3: Change generate + status APIs (cut Shotstack)

**Files:**

- Modify: `src/app/api/generate/route.js`
- Modify: `src/app/api/generate/status/route.js`
- Modify: `src/lib/user-credits.js` (atomic reserve + new refund helper)

**Step 1: `POST /api/generate`**

- Keep Pexels + `draftScript` + theme validation + `canGenerate`.
- Remove `buildShotstackTimeline` / `submitShotstackRender` (or leave dead code only until Task 8 cleanup).
- Insert:

```js
{
  user_id, clerk_user_id, prompt: topic, tone, subtitle_theme,
  script,
  render_id: null, // set after insert to id, or use id only
  status: 'pending',
  payload: { script, pexelsVideoUrls, tone, subtitleTheme, voice },
  attempts: 0,
  max_attempts: 3,
  next_visible_at: new Date().toISOString(),
  video_url: null,
}
```

- After insert, optionally `update render_id = id`.
- **Keep** calling `deductCreditIfNeeded` to reserve the credit. Replace its read-modify-write (`src/lib/user-credits.js`) with an atomic guarded decrement: `UPDATE users SET free_credits_remaining = free_credits_remaining - 1 WHERE id = $1 AND free_credits_remaining > 0 RETURNING *` via RPC; zero rows → 403 PAYWALL.
- **Do not** skip deduction for `is_premium` (Task 10 removes Unlimited bypass if still present).
- Return `{ renderId: videoRow.id, videoId, statusUrl: `/api/generate/status?id=${id}`, script, freeCreditsRemaining, … }`.

**Step 2: `GET /api/generate/status`**

- Load video by `id` + `clerk_user_id`.
- Return DB fields; no Shotstack fetch.
- 404 if missing.

**Step 3: Tests** for generate enqueue shape (mock Pexels/LLM) and status read.

**Done when:** Generate queues without Shotstack; status reflects DB.

---

### Task 4: Manual retry API

**Files:**

- Create: `src/app/api/videos/[id]/retry/route.js`
- Modify: `src/app/api/videos/route.js` — select `error`, `attempts`
- Tests: `__tests__/video-retry.test.js` (or route-level)

**Step 1: `POST` handler**

1. `auth()` → 401
2. Load video by id + clerk user → 404
3. If `status !== 'failed'` → 409
4. `canGenerate` → 403 `PAYWALL_REQUIRED`
5. Reset queue fields via `manualRequeue`
6. Return `{ renderId, statusUrl, … }` like generate

**Done when:** Failed job can be requeued; guards covered by tests.

---

### Task 5: Worker skeleton (claim loop, no real FFmpeg yet)

**Files:**

- Create: `worker/package.json`, `worker/index.js` (or `src/index.js`)
- Create: `worker/README.md` — how to run locally
- Create: `worker/.env.example`

**Step 1:** Worker loop:

```
while true:
  job = rpc claim_render_job(WORKER_ID)
  if !job: sleep 2–5s; continue
  heartbeat interval
  try:
    // stub: upload tiny placeholder or write a fixture mp4 to Storage
    completeJob(...)
    // credit already reserved at enqueue — no credit work on success
  catch err:
    failJob(retryable?)
```

**Step 2:** Heartbeat timer clears on exit.

**Step 3:** Document env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WORKER_ID`, `LEASE_SECONDS`.

**Done when:** Enqueued job from API becomes `done` with a Storage URL using the stub path.

---

### Task 6: Real render pipeline (TTS + FFmpeg + captions)

**Files:**

- Create: `worker/pipeline/*` (tts, download, ffmpeg, upload)
- Modify: worker entry to call pipeline
- Docker: `worker/Dockerfile` with `ffmpeg` installed (optional; same image can run on Lightsail)

**Step 1: TTS** — call chosen provider; write `audio.mp3` to job temp dir.

**Step 2: Download** — fetch `payload.pexelsVideoUrls` to disk.

**Step 3: Captions** — generate ASS or drawtext from script chunks + theme colors (port logic from `buildShotstackTimeline` caption chunking in generate route).

**Step 4: FFmpeg** — scale/crop 9:16, concat/xfade or simple concat, burn captions, mux TTS, output `out.mp4` ~45s HD.

**Step 5: Upload** — abstract upload behind a small helper (`uploadRender(localPath, key)`):
- Default / local: Supabase Storage bucket `renders`
- Prod path implemented in Task 8c: Cloudflare R2 via S3-compatible API

Set `video_url` (and optional thumbnail via ffmpeg frame grab).

**Step 6: Temp cleanup** — always `rm -rf` job dir in `finally`.

**Done when:** Real topic generate produces a playable vertical MP4 end-to-end on a machine with FFmpeg (Supabase Storage OK for this task).

---

### Task 7: Credit refund on final fail + frontend Retry UX

**Files:**

- Modify: worker fail path → refund once
- Modify: `src/components/CreatorWorkspace.js`
- Modify: `src/lib/user-credits.js` if adding `deductCreditForUserId(userId)` for worker/shared use
- Tests: credit edge cases

**Step 1:** On terminal `failed` transition only: increment `free_credits_remaining` by 1 (refund the enqueue-time reserve) for **all** users — do **not** skip when `is_premium`. Idempotency: refund only when the `credit_refunded` mark / guarded UPDATE succeeds.

**Step 2:** UI status mapping:

- `pending` / `claimed` → queued copy
- `running` → rendering copy
- `done` / `failed` → existing success/error

**Step 3:** History list: if `item.status === 'failed'`, show Retry → `POST /api/videos/${id}/retry` → start `pollUntilReady`.

**Step 4:** Remove Shotstack-specific strings in comments/UI.

**Done when:** User loses a credit only after success (failed refunds); Retry works from history.

---

### Task 8: Remove Shotstack + docs + CI

**Files:**

- Delete/stop using Shotstack URL constants and env checks
- Modify: `README.md`, `TESTING.md`, `.env.example` if present
- Modify: `package.json` scripts optional `worker:dev`
- Grep repo for `shotstack` / `SHOTSTACK` and clear

**Step 1:** Grep and remove.

**Step 2:** Document local full stack: `pnpm/npm run dev` + `node worker` (or Docker) + Supabase.

**Step 3:** Ensure unit tests pass in CI without worker/FFmpeg (mock RPC).

**Done when:** `rg -i shotstack` finds only historical docs/spec mentions (or none in `src/`).

---

### Task 8b: Deploy worker to AWS Lightsail

**Files:**

- Create/update: `worker/README.md` (Lightsail section)
- Optional: `worker/Dockerfile` + compose for the instance
- Optional: `worker/deploy/autoclips-worker.service` (systemd unit)

**Step 1:** Create a Lightsail Linux instance (Ubuntu LTS), open only SSH (no public HTTP required for the worker).

**Step 2:** Install Node (or Docker) + `ffmpeg`. Clone/deploy `worker/`; set env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, TTS keys, `WORKER_ID`, lease knobs, plus **R2** vars from Task 8c.

**Step 3:** Run under **systemd** or **pm2** so the claim loop restarts on crash/reboot. Cap to **1 worker process** (1 encode at a time). Document how to add a second process later (unique `WORKER_ID`, only after upsizing RAM).

**Step 4:** Verify logs show claim loop idle; enqueue one staging job from the Vercel app; confirm `done` + **R2** `video_url` (not Supabase Storage).

**Step 5:** Document instance size, region, restart procedure, **drain-then-restart upgrade** (pending jobs safe; running reclaims after lease), and how to pull updates in `worker/README.md`.

**Done when:** Staging/prod Lightsail worker stays up, completes real jobs against Supabase (queue), and serves MP4s from **R2**. Vercel unchanged for Next.js.

---

### Task 8c: Production object storage — Cloudflare R2

**Files:**

- Modify: `worker/pipeline/upload.js` (or equivalent) — support `STORAGE_BACKEND=r2`
- Modify: `worker/.env.example`, `worker/README.md`
- Optional: `__tests__` mock for R2 put + public URL shape
- Do **not** require R2 for local `npm run test` / local worker smoke (keep Supabase default)

**Why:** Supabase Storage is fine for MVP, but video views consume **egress** (Free 5 GB / Pro 250 GB then ~$0.09/GB). R2 gives **10 GB free storage** and **$0 egress** — correct for Autoclips playback.

**Step 1:** Create Cloudflare R2 bucket (e.g. `autoclips-renders`). Enable public access via R2.dev subdomain **or** custom domain.

**Step 2:** Create R2 API token with Object Read & Write on that bucket. Note Account ID + Access Key + Secret.

**Step 3:** Worker upload via S3-compatible client (`@aws-sdk/client-s3` or equivalent):

- Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- `PutObject` with `Content-Type: video/mp4`
- Public URL: `${R2_PUBLIC_BASE_URL}/${key}` → write to `videos.video_url`

**Step 4:** Env on Lightsail:

```
STORAGE_BACKEND=r2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=autoclips-renders
R2_PUBLIC_BASE_URL=https://pub-….r2.dev
```

Local default remains `STORAGE_BACKEND=supabase` (or unset).

**Step 5:** Smoke: one staging render → `video_url` hosts on R2; browser plays without Supabase Storage.

**Done when:** Prod/staging Lightsail uses R2 only for new renders; README documents both backends; historical Supabase URLs still play if present (no forced migration).

---

### Task 9: Hardening (retries + lease soak)

**Files:** worker + `__tests__` + optional small scanner script

**Step 1:** Integration test: fail twice with retryable → third succeeds.

**Step 2:** Integration test: max attempts → `failed`; manual retry → success.

**Step 3:** Kill worker mid-job; wait past lease; restart; job either completes or fails per attempts.

**Step 4:** Log structured fields: `video_id`, `attempt`, `step`, `duration_ms`, `retryable`.

**Done when:** Spec acceptance criteria 2–9 manually or automatically verified; checklist checked into `docs/plans/` or TESTING.md.

---

### Task 10: LemonSqueezy billing — Starter + Creator (replace Unlimited)

**Files:**

- Create: `src/app/api/webhooks/lemonsqueezy/route.js` (or `src/app/api/billing/webhook/route.js`)
- Create: `src/lib/billing-plans.js` (or constants) — map Lemon variant ids → credit amounts `{ starter: 15, creator: 60 }`
- Modify: `src/lib/user-credits.js` — `grantCredits(userId, n)`; remove / stop using deduct bypass for `is_premium`
- Modify: `src/components/CreatorWorkspace.js` — paywall CTAs + 4 checkout URLs
- Modify: `src/components/LandingPage.js` — pricing copy for both packs
- Modify: worker refund path — refund everyone (no premium skip)
- Optional migration: `lemon_customer_id`, `lemon_subscription_id`, `subscription_status`, `plan` (`starter` \| `creator`) on `users`
- Tests: `__tests__/user-credits.test.js`, webhook/variant→credits unit tests

**Step 1: Lemon dashboard**

- Create **Starter** subscription: $5/mo → 15 credits.
- Create **Creator** subscription: $15/mo → 60 credits.
- Create **Top-up Starter** one-time: $5 → +15.
- Create **Top-up Creator** one-time: $15 → +60.
- Record variant/product ids for webhook mapping.
- Configure webhook → production/staging Next URL; store signing secret in Vercel env.

**Step 2: Credits model**

- `canGenerate` / `deductCreditIfNeeded`: **only** check and decrement credits — ignore `is_premium` for gating (or delete bypass).
- `grantCredits(userId, n)` used by webhook (and optionally admin); `n` is **15 or 60** from variant map.
- On subscription `payment_success` / initial purchase: `+=` pack size.
- On top-up `order_created` (paid): `+=` pack size.
- On subscription cancelled: leave remaining balance; stop future grants.
- Checkout custom data must include Clerk `user_id` (or matchable email).

**Step 3: UI**

- Replace Unlimited $29 / placeholder checkout with Starter + Creator subscribe and top-up URLs.
- Paywall: subscribe $5 / $15; top-up $5 / $15.
- Landing `#pricing`: **$5 · 15 videos** and **$15 · 60 videos**; mention top-ups.

**Env (example)**

```
LEMONSQUEEZY_WEBHOOK_SECRET=
NEXT_PUBLIC_LEMON_CHECKOUT_STARTER_SUB=
NEXT_PUBLIC_LEMON_CHECKOUT_CREATOR_SUB=
NEXT_PUBLIC_LEMON_CHECKOUT_STARTER_TOPUP=
NEXT_PUBLIC_LEMON_CHECKOUT_CREATOR_TOPUP=
LEMON_VARIANT_STARTER=   # server-only map → 15
LEMON_VARIANT_CREATOR=   # server-only map → 60
```

**Step 4: Tests**

- Subscribed/paid user with 0 credits → PAYWALL.
- Grant helper increments by 15 and by 60.
- Refund still works for paid users on failed jobs.
- Unknown variant → no grant / logged error.

**Done when:** Spec acceptance 16–18 pass; no UI copy says Unlimited; webhook grants 15 or 60 by variant.

---

## Suggested implementation order

```
Task 0 → 1 → 2 → 3 → 4 → 5 → 7 (UI can poll stub locally)
              ↓
            Task 6 (real FFmpeg, local / Supabase Storage)
              ↓
            Task 8 → 8c (R2 upload) → 8b (Lightsail + STORAGE_BACKEND=r2) → 9
              ↓
            Task 10 (LemonSqueezy Starter + Creator sub/top-up; can parallelize with 8b once credits helpers exist)
```

Ship stub worker early so API/UI can be developed without waiting on FFmpeg polish. Local first (Supabase Storage OK). Before/at Lightsail prod: switch uploads to **R2**. Billing (Task 10) can start after Task 7 once credits are single-path for all users.

---

## Definition of done (release)

- [ ] All spec acceptance criteria pass (including pricing 16–18)
- [ ] Shotstack not required for generate/status
- [ ] Worker Dockerfile/README (+ systemd or pm2 notes)
- [ ] Lightsail worker deployed and completing jobs (**1 process**)
- [ ] Prod/staging uploads to **Cloudflare R2**; `video_url` is an R2 (or custom-domain) HTTPS URL
- [ ] Migration applied to prod Supabase
- [ ] Credits: reserve-at-enqueue + refund-on-fail for **all** users; no Unlimited bypass
- [ ] LemonSqueezy Starter ($5/15) + Creator ($15/60), each as sub + top-up; webhooks grant by variant
- [ ] Landing + paywall copy match locked pricing
- [ ] Manual Retry in UI
- [ ] Spec + this plan left in `docs/plans/` for future agents
- [ ] Upgrade/drain procedure documented in `worker/README.md`
