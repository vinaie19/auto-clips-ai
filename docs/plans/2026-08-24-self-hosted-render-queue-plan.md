# Self-Hosted Render Queue — Implementation Plan

> **For Claude:** Implement task-by-task. Do not skip tests. Spec is source of truth for behavior.

**Goal:** Replace Shotstack with a Postgres-backed render queue, always-on FFmpeg worker, automatic retries, and manual user retry — matching [`2026-08-24-self-hosted-render-queue-spec.md`](./2026-08-24-self-hosted-render-queue-spec.md).

**Architecture:** Next.js owns auth, credits gates, script/Pexels, enqueue, status, manual retry. Worker owns claim/lease/TTS/FFmpeg/Storage/`done`. Queue = extended `videos` table. No Redis. No Flotorch multi-node graph.

**Tech stack:** Next.js 16, Supabase (Postgres + Storage), Clerk, FFmpeg (worker), Vitest, Playwright (as needed).

**Spec:** `docs/plans/2026-08-24-self-hosted-render-queue-spec.md`

---

### Task 0: Lock open questions

**Files:** update spec “Open Questions” section after decisions.

**Step 1:** Choose TTS provider and map `Moody | Corporate | Cinematic` → voice ids.

**Step 2:** Choose Storage bucket name (e.g. `renders`) and URL style (public vs signed).

**Step 3:** Choose rollout: hard cut vs `RENDER_BACKEND=shotstack|self` flag (recommend **hard cut** if traffic is low; flag if you need soak).

**Step 4:** Confirm worker as Node in `worker/` at repo root.

**Done when:** Spec open questions answered in writing (edit the spec file).

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
- Modify: `src/lib/user-credits.js` (if needed for refunds — v1 deduct-on-done only)

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
- **Do not** call `deductCreditIfNeeded`.
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
    deductCreditIfNeeded for job.user_id (idempotent)
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
- Docker: `worker/Dockerfile` with `ffmpeg` installed

**Step 1: TTS** — call chosen provider; write `audio.mp3` to job temp dir.

**Step 2: Download** — fetch `payload.pexelsVideoUrls` to disk.

**Step 3: Captions** — generate ASS or drawtext from script chunks + theme colors (port logic from `buildShotstackTimeline` caption chunking in generate route).

**Step 4: FFmpeg** — scale/crop 9:16, concat/xfade or simple concat, burn captions, mux TTS, output `out.mp4` ~45s HD.

**Step 5: Upload** — Supabase Storage; set `video_url` (and optional thumbnail via ffmpeg frame grab).

**Step 6: Temp cleanup** — always `rm -rf` job dir in `finally`.

**Done when:** Real topic generate produces a playable vertical MP4 end-to-end on a machine with FFmpeg.

---

### Task 7: Credits on done + frontend Retry UX

**Files:**

- Modify: worker complete path → deduct once
- Modify: `src/components/CreatorWorkspace.js`
- Modify: `src/lib/user-credits.js` if adding `deductCreditForUserId(userId)` for worker/shared use
- Tests: credit edge cases

**Step 1:** On `done` transition only: if not premium, decrement `free_credits_remaining` by 1 with `where free_credits_remaining > 0` (or unconditional for already-checked generate — still guard concurrency).

**Step 2:** UI status mapping:

- `pending` / `claimed` → queued copy
- `running` → rendering copy
- `done` / `failed` → existing success/error

**Step 3:** History list: if `item.status === 'failed'`, show Retry → `POST /api/videos/${id}/retry` → start `pollUntilReady`.

**Step 4:** Remove Shotstack-specific strings in comments/UI.

**Done when:** Free user loses a credit only after success; Retry works from history.

---

### Task 8: Remove Shotstack + docs + CI

**Files:**

- Delete/stop using Shotstack URL constants and env checks
- Modify: `README.md`, `TESTING.md`, `.env.example` if present
- Modify: `package.json` scripts optional `worker:dev`
- Grep repo for `shotstack` / `SHOTSTACK` and clear

**Step 1:** Grep and remove.

**Step 2:** Document local full stack: `pnpm/npm run dev` + `node worker` + Supabase.

**Step 3:** Ensure unit tests pass in CI without worker/FFmpeg (mock RPC).

**Done when:** `rg -i shotstack` finds only historical docs/spec mentions (or none in `src/`).

---

### Task 9: Hardening (retries + lease soak)

**Files:** worker + `__tests__` + optional small scanner script

**Step 1:** Integration test: fail twice with retryable → third succeeds.

**Step 2:** Integration test: max attempts → `failed`; manual retry → success.

**Step 3:** Kill worker mid-job; wait past lease; restart; job either completes or fails per attempts.

**Step 4:** Log structured fields: `video_id`, `attempt`, `step`, `duration_ms`, `retryable`.

**Done when:** Spec acceptance criteria 2–9 manually or automatically verified; checklist checked into `docs/plans/` or TESTING.md.

---

## Suggested implementation order

```
Task 0 → 1 → 2 → 3 → 4 → 5 → 7 (UI can poll stub)
              ↓
            Task 6 (real FFmpeg)
              ↓
            Task 8 → 9
```

Ship stub worker early so API/UI can be developed without waiting on FFmpeg polish.

---

## Definition of done (release)

- [ ] All spec acceptance criteria pass
- [ ] Shotstack not required for generate/status
- [ ] Worker Dockerfile + README
- [ ] Migration applied to prod Supabase
- [ ] Credits: deduct-on-done verified
- [ ] Manual Retry in UI
- [ ] Spec + this plan left in `docs/plans/` for future agents
