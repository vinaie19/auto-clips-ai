# B-Roll Accuracy + Visual Styles — Implementation Plan

> **For Claude:** Implement task-by-task. Do not skip tests. Fold the locked decisions below exactly as written; where a decision says "soft skip", do not re-argue the trade-off — implement it as stated.

**Goal:** Make AutoClips' auto-generated videos match their narration more closely and support additional visual styles. Three outcomes: (1) B-roll accuracy — expand stock coverage beyond Pexels to Pixabay so the selected clip more often depicts *what the line says*, with style-aware provider routing; (2) add explicit **visual styles** — cartoon, 2D animation, 3D animation, motion graphics, anime/comic, realistic, cinematic, horror/dark — and route footage accordingly, *without* reworking the user's purpose taxonomy (educational, motivational, etc.) into a single flat enum; (3) surface that taxonomy in the product — a **Visual style** picker threaded through `/api/generate` (which also auto-derives `purpose` from tone). Without (3) the taxonomy is unreachable: today the form and API carry only topic/tone/subtitleTheme/captionsEnabled/voice/duration/aspectRatio.

**Architecture:** Keep the existing `worker/pipeline/prepare` seam intact — `fetchBrollForQueries(queries, opts)` and `planVisualBeats(script, topic)` remain the public entry points, so callers and tests keep working. Behind `fetchBrollForQueries`, introduce a small provider abstraction (`searchCandidates(query, opts)` + `toAsset` + `toProviderParams` per provider) that hides Pexels vs Pixabay from the rest of the pipeline — including a per-provider **orientation adapter** (named task, T2 Step 2) that maps internal `portrait`/`landscape`/`square` onto each provider's actual param vocabulary instead of passing it through verbatim. A new style-taxonomy module supplies two enums and two preset maps; the B-roll fetch keys off **visual style only** (not purpose). The producer (`worker/pipeline/prepare/index.js`) threads `payload.visualStyle` (and records `payload.purpose`) through `planVisualBeats` → `fetchBrollForQueries` → the new provider layer. The request surface is closed in the same plan (D13): `CreatorWorkspace` gains a Visual style picker, and `/api/generate` validates and persists `payload.visualStyle` while auto-deriving `payload.purpose` from tone via `PURPOSE_BY_TONE` — so the taxonomy ships reachable, not dormant.

**Tech stack:** Node (FFmpeg worker) + Pexels Video API + Pixabay Video API (`video_type=animation` for cartoon/animated coverage) + gpt-4o-mini (vision verify, split into independent relevance + style verdicts per D6/T3) + Supabase. Vitest + React Testing Library (`npm run test`) for unit tests; one seam-level test. No new dependencies.

**Spec:** This plan is self-contained (there is no separate spec file for this change; the prior render-queue spec does not cover B-roll styles).

---

## Locked decisions

> All decision points below were walked through interactive review and answered by the user. `SOFT SKIP` is a deliberate user deviation from the reviewer's recommendation and is implemented as written.

| # | Decision | Choice (locked) |
|---|----------|-----------------|
| D1 | Provider strategy | Use **both** Pexels and Pixabay. Style-aware routing (see D5/D6). Never expose a manual provider picker to users. |
| D2 | Taxonomy shape | **Two independent dimensions**: `purpose` (educational, social/news, product promotion, storytelling, motivation, tutorial, documentary, horror/story recap) and `visualStyle` (realistic, cinematic, cartoon, 2D animation, 3D animation, motion graphics, anime/comic, horror/dark, minimal, vintage). The existing `tone` (VIDEO_TONES: Cinematic, Educational, Storyteller, …) is a **narration-only** axis and is intentionally *not* part of this taxonomy — relationship and precedence per D14. Canonical `visualStyle` ids are the **10 lowercase-with-spaces** keys listed above (`2d animation`, `motion graphics`, `anime/comic`, …); client, API, and worker key off this exact casing — any drift is F11. |
| D3 | Abstraction boundary | **Refactor in place** behind `fetchBrollForQueries`. Shared `searchCandidates(query, opts)` + `toAsset` per provider. Users never choose a provider. |
| D4 | Licensing / attribution | Store only `provider` + `providerAssetId` on each beat for auditability. No credits, no attribution string. Provider terms verified in this plan (2026-08-27, see D7/T9): Pexels free license and Pixabay Content License permit unattributed commercial use for rendering; Pixabay additionally asks that attribution be shown "whenever search results are displayed" to end users — not triggered here, since we never surface result thumbnails. |
| D5 | Style routing | realistic/cinematic → Pexels first, Pixabay fallback; cartoon/2D/3D/motion/anime → **Pixabay first** (`video_type=animation`), Pexels fallback; horror/dark → Pexels first, Pixabay fallback; minimal/vintage/purpose-only → Pexels first. |
| D6 | Style strictness | **Tiered, split verdict.** cartoon/2D/3D/motion-graphics/anime → line relevance (existing `match`, `CLIP_MATCH_THRESHOLD` 0.6) AND a **separate** `styleMatch` (new, `STYLE_MATCH_THRESHOLD` 0.4) must both pass in one vision call, else reject+retry — never silently degrade to realistic. The style axis gets its own capped retry budget `MAX_STYLE_RETRIES` (2) — strictly smaller than the relevance budget (`MAX_VISION_ATTEMPTS`×`MAX_QUERY_ROUNDS`) — plus a per-render hard cap `MAX_VISION_CALLS_PER_RENDER` (30). cinematic/horror/dark → relevance pass + style as tiebreak. realistic/purpose-only → relevance only. On strict-style miss: **SOFT SKIP** — render whatever beats remain; no style-count floor (only the existing total `MIN_VISUAL_BEATS` floor stays) — and the shortfall is **logged** (`styleAcceptanceRate` in `prepare_broll_ok`) and **flagged** (`payload.styleDegraded`, D15), so a sparse on-style render is observable, not silent. |
| D7 | Rate limits, caching & fair use | Read per-provider rate headers every response (Pexels `X-Ratelimit-*`; Pixabay `X-RateLimit-*` — different casing). Concrete ceiling: Pixabay documented default is 100 req/60s, so pace to **≤ 1 req/s**; on `remaining` ≤ floor or a 429, back off (honor `X-RateLimit-Reset`, else 60s) and swap provider — never bypass. Cache **search results for 24h** (Pixabay: "requests must be cached for 24 hours"), plus a **short-lived per-render media cache keyed by `providerAssetId`** so repeated beats don't re-download the same footage file (fair-use mitigation: "systematic mass downloads are not allowed"). |
| D8 | Style config | **Two enums + two preset maps**: `PURPOSE` and `VISUAL_STYLE`; `PURPOSE_STYLE_DEFAULT` (purpose → default style) and `STYLE_QUERY_VOCAB` (style → query vocabulary). |
| D9 | Style vocab | Inject preset style vocabulary into query generation, **honoring** any user-supplied vocab over presets. |
| D10 | B-roll keying | B-roll routing/strictness keys on **style only**, not purpose. |
| D11 | Test scope | Unit tests + **one seam test** (asserting the new provider/router behavior through `fetchBrollForQueries`'s contract). |
| D12 | Missing Pixabay key | **Graceful degrade**: log `provider_unavailable`, route to Pexels only, never throw on config. |
| D13 | Product surface (style picker + purpose auto-suggestion) | Thread the taxonomy end-to-end. `CreatorWorkspace` gets a **Visual style** dropdown (Auto + the 10 D2 styles) posted to `/api/generate`; `route.js` reads `body.visualStyle`, validates against the canonical ids, and persists it in `payload`. `purpose` is **never** a manual picker — `route.js` derives it from tone via `PURPOSE_BY_TONE` (auto-suggested). Absent/`"auto"` style → omit `payload.visualStyle` (worker falls back to Auto, F7); non-empty unknown style → 400. |
| D14 | tone vs visualStyle vs purpose | **Three independent fields; no cross-overrides.** `tone` (existing `VIDEO_TONES` — Cinematic, Educational, Storyteller, Moody, Corporate, Playful, Urgent, Luxurious) drives **narration only**: script drafting (`draftScript(topic, tone, …)` uses `VIDEO_TONES[tone].scriptGuide`) and the default TTS voice (`resolveTtsVoice(voice, tone)`). It is never passed to B-roll. `visualStyle` (new) drives **footage only**: provider routing (D5), query vocabulary (D8/D9), and style strictness (D6). It is never passed to script/TTS. `purpose` (new) is **informational** (recorded on `payload`); its only effect is supplying a default style via `PURPOSE_STYLE_DEFAULT` (D8 / Task 1) when `visualStyle` is absent. The name overlap is intentional independence, not precedence — tone "Cinematic" does not influence style "cinematic"; tone "Educational"/"Storyteller" does not influence purpose "educational"/"storytelling". **Precedence when both could supply a style: an explicit `visualStyle` always wins over the purpose-derived default.** UI note: a tone pick may pre-select a matching style default, but tone and style remain separate controls — changing tone must not silently change footage routing. |
| D15 | Strict-style shortfall signal | **Accept fewer cuts + flag the job — never silently degrade.** When a strict tier resolves fewer than `MIN_VISUAL_BEATS` on-style beats (e.g. anime → only 2 `styleMatch` clips), the render keeps whatever on-style beats remain (D6 SOFT SKIP, no hard style floor) **and** persists `payload.styleDegraded: true` with the `styleAcceptanceRate`, so the job carries a durable, queryable signal. A user-facing "style approximated / fewer cuts" note is deferred to a future UI task that reads this flag — the flag is the non-silent hook today, because D6 forbids the alternative (degrading to realistic). |

---

## NOT in scope

- **Attribution/credits UX** — we store no attribution, so there is no UI to build. Deferred until a provider's terms change (one-line rationale: current Pexels free license and Pixabay Content License both permit unattributed commercial use for these use cases).
- **Provider manual picker** — users never choose a provider (D3); deliberately out of scope to keep the API invisible.
- **Persistent media library / durable asset cache** — clips are fetched and passed to FFmpeg per render; a *persistent* media library or durable asset store is not part of this plan (deferred: adds storage + rights-complexity for no v1 benefit). A short-lived, per-render **media dedupe keyed by `providerAssetId`** *is* in scope (D7, T4) so a single render never re-downloads the same footage file. Files live in the render's temp dir and are cleared with it — no durable store.
- **Style-count floor on strict-miss** — the user chose SOFT SKIP over "skip + hard floor"; enforcing a minimum count of on-style beats is explicitly NOT built.
- **Purpose as a routing key** — purpose is recorded and may later power presets, but routing consumes style only (D10); purpose-driven routing deferred.
- **Pixabay video uploads / original content** — we only consume Pixabay search results; no upload integration.
- **New TTS / render logic** — beyond the minimal request-surface thread (D13: `route.js` + `CreatorWorkspace` picker + purpose auto-derivation), this plan touches only B-roll query planning and clip selection; script drafting, TTS, and FFmpeg assembly are unchanged.
- **`.env` changes** — `PIXABAY_API_KEY` is added as a *read* of an env var the user supplies; this plan does not create or modify `.env` files and never edits `worker/.env`.

## What already exists

- **`worker/pipeline/prepare/pexels-broll.js`** (production) — implements the entire line-bound B-roll flow: `collectClipCandidates` (orientation try-order + mp4/preview pick), `resolveVerifiedClip` (gpt-4o-mini vision loop with `MAX_VISION_ATTEMPTS`/`MAX_QUERY_ROUNDS`, `betterQuery` retry, `bestRejected` keep), `pickUnusedClip` (no-vision fallback), `mapPool` bounded concurrency, and the seam `fetchBrollForQueries` (cleans/caps to 15, parallel drafts, serial unique-URL claim pass, MIN_VISUAL_BEATS floor with 502, returns `{ pexelsVideoUrls, visualBeats, motif }`). **This is the seam the refactor must keep stable** — D3 says refactor its internals, not its signature.
- **`worker/pipeline/prepare/visual-queries.js`** (production) — `planVisualBeats(script, topic)` calls gpt-4o-mini to bind one stock query per spoken line; `normalizeVisualPlan(raw, topic, {lines})` aligns 1:1 to authoritative lines and hardens vague queries via `hardenStockQuery(query, line, topic)`; `beatLinesFromScript` clamps MIN/MAX beats; `deriveVisualQueries` is `@deprecated` (keep working; do not delete without checking callers).
- **`worker/pipeline/prepare/index.js`** (production entry) — `prepareJobAssets` reads `payload`, drafts script (`draftScript`), calls `planVisualBeats(script, topic)` (line 82) then `fetchBrollForQueries(visualPlan.queries, {weights, lines, motif, orientation})` (lines 92–100), then persists `pexelsVideoUrls/visualBeats/visualQueries/visualLines/visualMotif/visualAvoid` back to `payload`. **This is where `visualStyle`/`purpose` enter the pipeline.**
- **`src/lib/pexels-broll.js` and `src/lib/visual-queries.js` (copies, test-facing)** — verified this session: logically identical to the worker copies, differing only cosmetically (src/lib imports `@/lib/clip-verify` + says "server" + no 502 `status`; worker imports `./clip-verify.js` + says "worker" + sets 502). src/lib is imported **only by `__tests__/`** (`clip-verify.test.js`, `pexels-broll.test.js`, `visual-continuity.test.js`); worker copies are imported only by `worker/pipeline/prepare/index.js`. **The plan must either keep both copies in lock-step or resolve the duplication.** Recommended: keep one source of truth in `worker/`, and have `src/lib/<name>.js` re-export or be regenerated from it — but since the two copies already differ only in the import alias, the minimal-motion path is "touch both copies identically." The plan below tasks the duplication explicitly (T7) rather than silently editing one side.
- **`clip-verify.js`** — `verifyClipAgainstLine({ line, query, imageUrl })` returns `{ match, score, reason, betterQuery? }`. **Changed by this plan (T3):** gains an optional `style` input and returns `styleMatch` + `styleScore` alongside the relevance verdict — relevance (`match`, 0.6) and style (`styleMatch`, 0.4) are judged and thresholded **independently**, so the style axis cannot shift or corrupt the existing relevance check.
- **`src/lib/render-constants.js` + existing `tone` field** — `VIDEO_TONES` (Cinematic, Educational, Storyteller, Moody, Corporate, Playful, Urgent, Luxurious) carries `scriptGuide` + `defaultVoice`. `tone` is set on the enqueue payload in `src/app/api/generate/route.js` (from `body.tone`, default "Cinematic") and drives narration only: `draftScript(topic, tone, …)` (whose `worker/pipeline/prepare/script.js` holds a subset copy of `scriptGuide`) and `resolveTtsVoice(voice, tone)` for the default voice. Tone is **unrelated** to the new `visualStyle`/`purpose` fields — see D14; this plan neither reads nor changes tone.

- **`src/app/api/generate/route.js` + `src/components/CreatorWorkspace.js` (request surface)** — the enqueue path reads exactly seven fields (topic/tone/subtitleTheme/captionsEnabled/voice/targetDurationSeconds/aspectRatio) and builds the queue `payload` from those seven; `src/lib/render-constants.js` already holds the shared tone/subtitle/aspect enums + `resolve*` helpers and is imported by the API (`route.js`) and by the worker's prompt code. The style taxonomy has **no product surface today** — this plan closes that (D13, T10).

## Data-flow diagrams

With D13, `payload.visualStyle` originates in the picker → `route.js` → Supabase `payload`; `payload.purpose` is derived from tone at enqueue, same leg.

### Style-aware provider routing (per beat)

```
                      payload (visualStyle, purpose)  · tone stays in narration (D14)
                                │
                                ▼
        ┌───────────────────────────────────────────────┐
        │  planVisualBeats(script, topic, {visualStyle}) │  query gen
        │  · injects STYLE_QUERY_VOCAB[visualStyle]      │  (harden + vocab)
        │  · returns { motif, queries, weights, lines }  │
        └───────────────────────┬───────────────────────┘
                                ▼  queries[] (one per line)
        ┌───────────────────────────────────────────────┐
        │        fetchBrollForQueries(queries, opts)     │  SEAM (unchanged)
        │        opts now carries { visualStyle,         │
        │                          motif, orientation }  │
        └───────────────────────┬───────────────────────┘
                                ▼
        ┌───────────────────────────────────────────────┐
        │        providerRouter(visualStyle)            │
        │  realistic/cinematic/horror/purpose → Pexels   │
        │  cartoon/2D/3D/motion/anime → Pixabay (anim)   │
        └───────┬──────────────────────────┬────────────┘
                ▼ primary                  ▼ fallback
        ┌─────────────────┐        ┌─────────────────┐
        │ searchCandidates │        │ searchCandidates │
        │ (pexels|pixabay) │  swap  │ (other provider) │
        └───────┬─────────┘  ◄────  └─────────────────┘
                ▼               (rate-limit floor / empty result)
        vision verify (relevance; separate styleMatch if strict tier)
                ▼
        accept / reject+retry / betterQuery / keep-best
                ▼
        serial unique-URL claim pass (unchanged)
                ▼
        visualBeats: [{ query, url, line, weight,
                        provider, providerAssetId,
                        verified, retried }]
```

### Vision verify / strict-style retry (per candidate)

```
 candidate(url, imageUrl)
        │
        ▼
 missing image ──accept unverified──▶ pickUnusedClip path
        │
        ▼
 verifyClipAgainstLine(line, query, imageUrl, { style })
        │  returns { match, styleMatch, score, styleScore, reason, betterQuery? }
        │
        ├─ match && strictTier && !styleMatch
        │     └─▶ style reject → style-retry (≤ MAX_STYLE_RETRIES) then relevance betterQuery round
        ├─ match && (!strictTier || styleMatch)
        │     └─▶ accept verified ✓ (records styleMatch on the beat)
        └─ !match
              └─▶ reject (bestRejected) + betterQuery round
                    │
                    ▼  (after MAX rounds/attempts OR MAX_VISION_CALLS_PER_RENDER)
              keep bestRejected (verified:false) or null
```

```
 strictly-on-style beats < MIN_VISUAL_BEATS (strict tier):
        │
        ▼
 SOFT SKIP — no style-count floor; total floor = MIN_VISUAL_BEATS only
   · prepare_broll_ok logs styleAcceptanceRate (styleMatch beats / total)
   · payload.styleDegraded = true (D15) → observable, not silent
```

## Failure modes

| # | Codepath | Realistic failure | Test? | Error handling? | User-visible? | Gap? |
|---|----------|-------------------|-------|-----------------|---------------|------|
| F1 | Pixabay search returns HTTP 4xx (bad/expired key) | Wrong clips or silent empty | Seam test (D11) | `provider_unavailable` log + Pexels-only fallback (D12) | Still renders via Pexels | — |
| F2 | Rate headers hit floor / 429 mid-burst (ceiling breached) | 429s, dropped beats | Unit (rate-limit gate) | Back off (`X-RateLimit-Reset` or 60s) + swap provider + cache | Slower render, still renders | — |
| F3 | Strict-tier style check too strict → most beats rejected | Near-empty on-style beat set | Seam test | SOFT SKIP → renders whatever beats remain; total `MIN_VISUAL_BEATS` floor only; `prepare_broll_ok` logs `styleAcceptanceRate` and `payload.styleDegraded` is set (D15) | Fewer on-style cuts, but observable per job (no longer silent) | — |
| F4 | gpt-4o-mini vision returns `betterQuery` loop | Endless retry | Existing vision tests | `MAX_QUERY_ROUNDS`/`MAX_VISION_ATTEMPTS` caps (existing) | Renders best-rejected | — |
| F5 | Duplicate src/lib vs worker copies drift | Tests pass, prod broken (or vice versa) | T7 sync check | T7 tasks (re-export source of truth) | Silent behavioral skew | **critical gap → T7** |
| F6 | `planVisualBeats` signature change missed in one copy | 502 / undefined style | Unit + seam | Two-copy sync (T7); default style when `visualStyle` absent | Render fails for that path | **critical gap → Task 1 + T7** |
| F7 | `payload.visualStyle` absent (legacy jobs, or picker left on Auto) | Router falls to purpose-only path | Unit | `PURPOSE_STYLE_DEFAULT[payload.purpose] ?? "realistic"` (D14, T6 Step 1); "realistic" applies only when purpose maps to no style | Renders the purpose-derived default (e.g. documentary → cinematic) | — |
| F8 | Pixabay `video_type=animation` returns 0 for a realistic-topic line | Empty candidates | Seam | Provider swap to Pexels fallback (D5) | Renders realistic instead of cartoon → **soft skip consistent** | — |
| F9 | 24h search cache serves stale results after provider outage | Wrong clips for a beat | Unit (TTL) | 24h is Pixabay's documented cache requirement (accepted staleness window); miss refetches. Media cache is per-render only, so a stale file can't leak across jobs | Slightly stale clip, still relevant | — |
| F10 | `orientation` passed verbatim to Pixabay (`orientation=portrait`) or Pixabay videos API silently ignores the param | Off-aspect clips or silent no-filter | Unit + seam (`toProviderParams`, adapter log) | `toProviderParams` mapping; `min_width`/`min_height` or `videos[].large` dim-filter fallback (T2 Step 2) | Off-aspect clips, still renders | — |
| F11 | Style id the client posts doesn't match the worker taxonomy (casing/drift) | Style silently ignored → lands on Auto | Unit (`resolveVisualStyle`) + T10 sync note | `src/lib/render-constants.js` is the single id source for API+client; `worker/pipeline/prepare/video-taxonomy.js` (T1) uses the identical ids with a `Keep in sync` comment | Video rendered in default style, no error | — |
| F12 | Style retries churn past the vision budget (cost/latency) | Slow, expensive render | Unit (cap) | `MAX_VISION_CALLS_PER_RENDER` (30) hard-stops verify loops; remaining strict beats resolve via `pickUnusedClip`/best-rejected | Fewer verified cuts, bounded cost | — |
| F13 | User picks "anime" but only 2 on-style matches exist | Render has fewer on-style cuts than the beat count implies | Seam test + `prepare_broll_ok` metric | Accept fewer cuts (SOFT SKIP) AND persist `payload.styleDegraded: true` + `styleAcceptanceRate` (D15); D6 forbids silent degradation | Fewer cuts + durable flag (a user-facing note is deferred to reading the flag) | — |

Critical gaps (no test AND no handling AND silent) are flagged; each maps to an explicit task below (T1, T7), so nothing is left unhandled in the shipped plan.

## Worktree parallelization strategy

All tasks touch the **same primary module** (`worker/pipeline/prepare/`) — the taxonomy module (Task 1), the provider layer (Task 2), the router (Task 3), the query-gen (Task 5), and the seam caller (Task 6) are tightly coupled through `fetchBrollForQueries`'s contract. They cannot be split across worktrees without merge conflicts on the same files. The independent streams are the **test/fixture work (Task 8)**, the **doc/README key note (Task 9)**, and the **request surface (Task 10)** — which touch `__tests__/`, `worker/README`, and `src/app` + `src/components` + `src/lib/render-constants.js` respectively.

**Dependency table**

| Step | Modules touched | Depends on |
|------|----------------|------------|
| T1 Taxonomy (enums + presets) | `worker/pipeline/prepare/` (new file) | — |
| T2 Provider layer (Pexels + Pixabay) — incl. orientation adapter (Step 2) | `worker/pipeline/prepare/` | T1 |
| T3 Style-aware router | `worker/pipeline/prepare/` | T1, T2 |
| T4 Rate-limit gate + 24h search cache + media cache | `worker/pipeline/prepare/` | T2 |
| T5 Query-gen style injection | `worker/pipeline/prepare/` | T1 |
| T6 Seam caller (`index.js`) threading | `worker/pipeline/prepare/` | T3, T5 |
| T7 Duplication sync (src/lib ↔ worker) | `worker/pipeline/prepare/`, `src/lib/` | T6 |
| T8 Tests + fixtures | `__tests__/` | T6 |
| T9 README env note | `worker/` | T2 |
| T10 Request surface (picker + route + purpose) | `src/app/api/generate/route.js`, `src/components/CreatorWorkspace.js`, `src/lib/render-constants.js`, `__tests__/` | T1 (canonical style ids pinned) |

**Parallel lanes**

- `Lane A: T1 → T2 → T3 → T4 → T5 → T6 → T7 (sequential, shared worker/pipeline/prepare/)`
- `Lane B: T8 (independent, __tests__/)`
- `Lane C: T9 (independent, worker/README)`
- `Lane D: T10 (independent, src/app + src/components + src/lib/render-constants)`

**Execution order:** Implement Lane A sequentially in the main worktree (conflict-prone shared module — do NOT parallelize). Once T6 lands, Lane B (tests) and Lane C (docs) can run in parallel worktrees against it. Lane D (T10) starts as soon as **T1 pins the style-id list** and runs in its own worktree — it touches only `src/app`, `src/components`, and `src/lib/render-constants.js`.

**Conflict flags:** none — Lanes B and C touch only `__tests__/` and `worker/` docs respectively; Lane D touches only `src/app`, `src/components`, and `src/lib/render-constants.js`. None overlap Lane A's `worker/pipeline/prepare/`. Note: Lane A's T1 *pins* the canonical style-id list in `worker/pipeline/prepare/video-taxonomy.js` while Lane D *mirrors* those ids in `src/lib/render-constants.js` — the two files are distinct, so no conflict (the `Keep in sync` convention, F11, is what keeps them aligned).

---

### Task 1: Style taxonomy module (enums + preset maps)

**Files:**

- Create: `worker/pipeline/prepare/video-taxonomy.js`

**Step 1:** Create `PURPOSE` and `VISUAL_STYLE` enums (frozen string constants: `PURPOSE.EDUCATIONAL = "educational"`, etc.; `VISUAL_STYLE.CARTOON = "cartoon"`, `VISUAL_STYLE.CINEMATIC = "cinematic"`, …). Include all values from D2.

**Step 2:** Add `PURPOSE_STYLE_DEFAULT` map (purpose → default style; e.g. documentary → cinematic, horror/story recap → horror/dark, tutorial → realistic).

**Step 3:** Add `STYLE_QUERY_VOCAB` map (style → array of query words; e.g. `cartoon: ["cartoon", "animated", "illustration"]`, `"2d animation": ["2d animation", "flat illustration", "vector"]`, `"motion graphics": ["motion graphics", "kinetic typography", "abstract shapes"]`, `horror/dark: ["dark", "horror", "moody", "shadow"]`, `cinematic: ["cinematic", "film", "golden hour", "shallow depth of field"]`, `anime/comic: ["anime", "manga", "comic style"]`).

**Step 4:** Add `normalizeVisualStyle(input)` → canonical `VISUAL_STYLE` key when `input` is a known id, else `null` — do **not** hard-default to `"realistic"` here. (If it did, T6 Step 1's `??` chain would never reach `PURPOSE_STYLE_DEFAULT`: `normalizeVisualStyle(undefined)` would return the non-null value `"realistic"` and short-circuit the purpose fallback. The `"realistic"` fallback lives only in T6 Step 1.) Add `normalizePurpose(input)` → canonical `PURPOSE` key or `"storytelling"` when absent/unknown (matching `resolvePurpose`'s fallback in T10).

**Done when:** `node -e "import('./worker/pipeline/prepare/video-taxonomy.js').then(m => console.log(m.normalizeVisualStyle('cartoon'), Object.keys(m.STYLE_QUERY_VOCAB).length))"` prints a canonical key and a vocab count > 0.

---

### Task 2: Provider layer (Pexels + Pixabay behind one seam)

**Files:**

- Modify: `worker/pipeline/prepare/pexels-broll.js`
- Create: `worker/pipeline/prepare/providers.js` (or co-locate in pexels-broll.js if simpler — keep the shared `searchCandidates` shape per D3)

**Step 1:** Extract `searchPexelsOnce`/`collectClipCandidates`'s per-provider search into `searchCandidates(query, opts = {}, provider)`:
- Pexels: GET `https://api.pexels.com/v1/videos/search` (`Authorization` header, `query`, `per_page: "8"`, `orientation` — supplied by the Step 2 adapter, mapped per provider).
- Pixabay: GET `https://pixabay.com/api/videos/` (`key`, `q`, `per_page: "8"`, `video_type=animation` when style is in the animated/strict tier or explicitly requested, and orientation params via the Step 2 adapter — **never Pexels' `orientation` vocabulary verbatim**).
- Each returns `{ results: [{ url, imageUrl, assetId }], rate: { remaining, reset, limit } }`.

**Step 2 (named task) — provider orientation adapter:** Add `toProviderParams(orientation, provider)` and call it before every `searchCandidates` request, in both provider branches.
- **Mapping (verify before finalizing):** internal `orientation` vocabulary → per-provider params: `portrait` → Pexels `orientation=portrait` / Pixabay `vertical`; `landscape` → Pexels `orientation=landscape` / Pixabay `horizontal`; `square` → Pexels *no orientation param* (as `orientationTryOrder` already does) / Pixabay decided fallback (recommended `vertical`), with the decision recorded in a code comment. Nothing maps through verbatim.
- **Verify, don't assume:** check Pixabay's current videos-endpoint docs for whether an `orientation` filter exists there at all (the `orientation=horizontal|vertical` filter is on the images API; the videos endpoint filters by `min_width`/`min_height`/`video_type` instead). If the videos endpoint does not honor `orientation`, pass documented `min_width`/`min_height` params when available **and** keep a client-side guarantee: filter the Pixabay `videos[]` on `videos[].large.width` vs `.height` in Step 3. Emitting an ignored `orientation=portrait` that silently no-ops is not acceptable.
- Log `orientation_adapter: "params" | "dim-filter"` once per provider at search time so the chosen path is observable.

**Step 3:** Add `toAsset` normalization per provider (Pexels `video_files` mp4 scoring via existing `pickOptimalMp4`; Pixabay `videos[].videos`/`large` mp4 + `videos[].picture_id`-derived preview image) returning a uniform `{ url, imageUrl, provider, providerAssetId }`. When the Step 2 adapter chose `dim-filter`, apply the width/height filter to the Pixabay `videos[]` results here before asset selection.

**Step 4:** Move the provider search behind the existing helpers so `collectClipCandidates` and `pickUnusedClip` call `searchCandidates` for the *active* provider, not hard-coded Pexels.

**Step 5:** Validate keys per-provider: Pexels throw-on-missing behavior for `PEXELS_API_KEY` is preserved (existing seam behavior). Pixabay missing/placeholder → return `provider_unavailable` marker, do NOT throw (D12).

**Done when:** existing `npm run test` b-roll tests still pass, and a quick manual `node -e` call confirms `searchCandidates("coffee", { orientation: "portrait" }, "pixabay")` returns the normalized shape (or `provider_unavailable` unset when key present) — and, via a param dump or network capture, that the Pixabay request carries the mapped vocabulary (`vertical`, or `min_width`/`min_height`, or the dim-filter path), **never the literal `orientation=portrait`**.

---

### Task 3: Style-aware provider router

**Files:**

- Modify: `worker/pipeline/prepare/pexels-broll.js`
- Modify: `worker/pipeline/prepare/clip-verify.js`

**Step 1:** Add `providerOrderForStyle(visualStyle)` implementing D5: returns `["pixabay", "pexels"]` for animated tier (`cartoon`, `2d animation`, `3d animation`, `motion graphics`, `anime/comic`), else `["pexels", "pixabay"]` (horror/dark, cinematic, realistic, minimal, vintage, purpose-only). Pixabay entry for the animated tier passes `video_type=animation`.

**Step 2:** In `collectClipCandidates` and `pickUnusedClip`, iterate the ordered providers, querying primary then fallback, stopping at the first provider that yields candidates or after both are exhausted. Record `provider` + `providerAssetId` on each candidate.

**Step 3:** Preserve the orientation try-order and `usedUrls`/seen dedupe semantics exactly — the uniqueness contract must not change.

**Step 4:** Split the vision verdict — keep relevance, add an independent style axis (D6). In `clip-verify.js`, add `STYLE_MATCH_THRESHOLD = 0.4` next to `CLIP_MATCH_THRESHOLD`, accept `input.style` (a canonical `VISUAL_STYLE` id or null), and have `normalizeClipVerdict` return two independent booleans. Relevance and style share one call but separate thresholds — adding the style axis must not change the `match` computation:

```js
export const STYLE_MATCH_THRESHOLD = 0.4;

// normalizeClipVerdict additions:
const styleScoreRaw = Number(parsed?.styleScore);
const styleScore = Number.isFinite(styleScoreRaw)
  ? Math.min(1, Math.max(0, styleScoreRaw))
  : null;
const styleMatch = styleScore === null ? null : styleScore >= STYLE_MATCH_THRESHOLD;
// return { match, score, reason, betterQuery, styleMatch, styleScore }
```

When `input.style` is set, append to the system prompt that the still must also look like `<style>` (cartoon → flat 2D cartoon illustration, not live action; 2d animation → flat vector; 3d animation → rendered 3D; motion graphics → kinetic type/abstract shapes; anime/comic → anime/manga art, not photoreal) and add `"styleScore": 0.0` to the returned-JSON template. When `style` is absent, the prompt and JSON are byte-identical to today, and `normalizeClipVerdict` returns `styleMatch: null` / `styleScore: null` — regression-safe for realistic/purpose-only and all existing `clip-verify.test.js` cases.

**Step 5:** Enforce the style budget in `resolveVerifiedClip`. In `pexels-broll.js`, export `MAX_STYLE_RETRIES = 2` and `MAX_VISION_CALLS_PER_RENDER = 30` next to `MAX_VERIFY_CANDIDATES`. Thread `visualStyle` into `resolveVerifiedClip({ ..., visualStyle })` (from `resolveBeatDraft` and the `pickUnusedClip` fallback sites). Strict tier = `providerOrderForStyle(visualStyle)[0] === "pixabay"` (the animated set from Step 1); only strict-tier calls pass `style: visualStyle` to `verifyClipAgainstLine`. Track a per-beat `styleRetries` counter **separate from** `visionAttempts`, and a render-scoped `visionCalls` counter initialized to 0 at the top of `fetchBrollForQueries` and passed (as a mutable object) into `resolveVerifiedClip` — increment it on **every** `verifyClipAgainstLine` call, and break every verify loop when it reaches `MAX_VISION_CALLS_PER_RENDER` (remaining beats fall through to `pickUnusedClip`/best-rejected, never to a dropped `MIN_VISUAL_BEATS` constant). Accept only when `match && (!strictTier || styleMatch)`; a strict-tier `match && !styleMatch` consumes a `styleRetries` slot (≤ `MAX_STYLE_RETRIES`) before/instead of a full `betterQuery` round, while the relevance retry budget (`MAX_VISION_ATTEMPTS`/`MAX_QUERY_ROUNDS`) stays exactly as today.

**Step 6:** Record `styleMatch` per beat and produce the acceptance metric (D15). Add `styleMatch` to the beat object `fetchBrollForQueries` pushes (`styleMatch: resolved.styleMatch ?? false`; false when the tier is non-strict or the beat came from `pickUnusedClip`). Before the summary log, compute:

```js
const strictTier = providerOrderForStyle(visualStyle)[0] === "pixabay";
const styleBeats = strictTier
  ? visualBeats.filter((b) => b.styleMatch === true).length
  : 0;
const styleAcceptanceRate = strictTier
  ? visualBeats.length > 0 ? styleBeats / visualBeats.length : null
  : null;
const styleDegraded = strictTier && styleBeats < MIN_VISUAL_BEATS;
// return { pexelsVideoUrls, visualBeats, motif, styleAcceptanceRate, styleDegraded } // additive
```

Extend the `broll_unique_summary` log with `style_beats`, `style_acceptance_rate`, `vision_calls`. Non-strict tiers return `styleAcceptanceRate: null`, `styleDegraded: false` — existing callers destructure only the known three keys, so the return-shape change is additive.

**Done when:** a unit test asserts (a) `cartoon` → first call Pixabay `video_type=animation` and `realistic` → first call Pexels (unchanged), (b) a still judged relevance-match but style-mismatch returns `{ match: true, styleMatch: false }` and rejects on a strict tier, and (c) `normalizeClipVerdict` with no `style` request returns `styleMatch: null` with the same `match` as before for identical raw input.

---

### Task 4: Rate-limit gate + 24h search cache + per-render media cache

**Files:**

- Modify: `worker/pipeline/prepare/pexels-broll.js`

**Step 1:** Read the rate headers from each search response and expose `{ remaining, reset, limit }` on the result. Mind the casing difference — Pexels uses `X-Ratelimit-*`, Pixabay uses `X-RateLimit-*` — so do not read both providers through a single header name.

**Step 2:** Add a per-provider rate gate with concrete numbers (not just a floor):
- **Pixabay ceiling — pace to ≤ 1 req/s.** Documented default is 100 req/60s (≈ 1.67 req/s); our ceiling is ~half that. Enforce a min 1000ms gap between Pixabay search calls *within* a job.
- On `remaining` ≤ `providerRemainingFloor` (default 5) **or an HTTP 429**, swap to the fallback provider for the current beat (log `rate_limit_swap`) and back off: honor `X-RateLimit-Reset` if present, else a 60s default.
- **Pexels:** same floor/swap/backoff against its `X-Ratelimit-*` headers; its per-hour quota is ample for one per-render batch, so no extra pacing is needed at v1.
- Never exceed/sleep past a provider's stated limit (no bypass).

**Step 3:** Add two distinct caches — they solve different problems:
- **Search-results cache, 24h TTL.** Key `provider|query|orientation` (`Map` + TTL). Pixabay documents "requests must be cached for 24 hours", so honor that window (previously 60s). Directory/video-key changes within 24h are an accepted trade-off (F9). `cache: "no-store"` stays on the network fetch; read/write best-effort, refetch on miss.
- **Per-render media cache, keyed by `providerAssetId`.** In-memory `Map<providerAssetId → tmpFile>` scoped to one job, holding each downloaded footage file once so beats resolving to the same asset reuse the file instead of re-downloading it. This is the fair-use mitigation: Pixabay prohibits "systematic mass downloads", and without it a high-volume render re-fetches the same files repeatedly. Files are written to the job's temp dir and cleared with render temp on job end — no durable asset store.

**Step 4:** Log `rate_limit_swap`, `provider_cache_hit`, `provider_media_cache_hit`, `provider_unavailable` (D12) as JSON events for observability.

**Done when:** unit tests (fake timers) assert (a) a second identical search within 24h returns the cached result without a network call, (b) two beats resolving to the same `providerAssetId` fetch the media file once, and (c) a floor/429 condition triggers a fallback-provider swap.

---

### Task 5: Query-gen style injection

**Files:**

- Modify: `worker/pipeline/prepare/visual-queries.js`

**Step 1:** Change `planVisualBeats(script, topic, { visualStyle } = {})` to accept the style (F6), thread it into `normalizeVisualPlan(raw, topic, { lines, visualStyle })` and `hardenStockQuery(query, line, topic, visualStyle = null)`.

**Step 2:** Inject `STYLE_QUERY_VOCAB[visualStyle]` into the gpt-4o-mini system prompt ("prefer describing with a <style> look: cartoon/2D flat illustration" etc.), honoring any user-supplied vocab string over presets (D9). When `visualStyle` is absent, emit the current prompt unchanged.

**Step 3:** Harden queries with a style-aware tail: append a style vocabulary term when the query is otherwise vague and a style is set. Keep vague-query ban behavior identical when no style.

**Step 4:** Bump the deprecated `deriveVisualQueries` to accept and ignore/pass-through the style arg so callers stay valid.

**Done when:** a unit test asserts a `cartoon` style produces queries containing style vocabulary and a no-style call matches today's output for the same script.

---

### Task 6: Seam caller threading + licensing fields

**Files:**

- Modify: `worker/pipeline/prepare/index.js`
- Modify: `worker/pipeline/prepare/pexels-broll.js` (beat shape)

**Step 1:** In `prepareJobAssets`, read `payload.purpose = normalizePurpose(payload.purpose)`, then resolve `payload.visualStyle` with the exact chain `payload.visualStyle = normalizeVisualStyle(payload.visualStyle) ?? PURPOSE_STYLE_DEFAULT[payload.purpose] ?? "realistic"`. Explicit, known style wins; when `visualStyle` is absent/unknown (`normalizeVisualStyle` returns `null`, see T1 Step 4), apply the purpose-derived default (D14 — this is the one line that makes `purpose` actually affect footage); `"realistic"` applies only when purpose maps to no style. Log both resolved values at `step_prepare`.

**Step 2:** Pass `{ visualStyle }` to `planVisualBeats(script, topic, { visualStyle })`.

**Step 3:** Pass `visualStyle` to `fetchBrollForQueries(visualPlan.queries, { weights, lines, motif, orientation, visualStyle })`.

**Step 4:** In `fetchBrollForQueries`, accept `opts.visualStyle` and thread it into the router (Task 3). Persist `provider` and `providerAssetId` from each accepted beat into the returned `visualBeats` entries (D4); keep `pexelsVideoUrls` unchanged (still an array of URLs).

**Step 5:** Persist `visualStyle` and `purpose` onto `payload` in the returned `nextPayload` alongside the existing fields (`visualQueries`, `visualLines`, `visualMotif`, `visualAvoid`).

**Step 6:** Surface the strict-style signal (D15, T3 Step 6). Destructure `styleAcceptanceRate` and `styleDegraded` from the `fetchBrollForQueries` return (lines 92–100) and add them to the `prepare_broll_ok` log (lines 101–107): `style_acceptance_rate` and `style_degraded`. Persist `styleDegraded` and `styleAcceptanceRate` into `nextPayload` so the job row carries the flag; when the tier is non-strict `styleDegraded` is `false` and `styleAcceptanceRate` is `null` — omit `styleAcceptanceRate` from `nextPayload` in that case rather than writing `undefined`.

**Done when:** `npm run test` passes and a seam test asserts `fetchBrollForQueries(["cartoon dog running"], { visualStyle: "cartoon" })` returns beats carrying `provider`/`providerAssetId` and routed to Pixabay, plus a `styleAcceptanceRate` (number or `null`) and a `styleDegraded` boolean; with a sparse on-style mock the call returns `styleDegraded: true`.

---

### Task 7: Resolve the src/lib ↔ worker duplication (critical gap F5/F6)

**Files:**

- Modify: `worker/pipeline/prepare/pexels-broll.js`, `src/lib/pexels-broll.js`, `worker/pipeline/prepare/visual-queries.js`, `src/lib/visual-queries.js`, `worker/pipeline/prepare/clip-verify.js`, `src/lib/clip-verify.js`

**Step 1:** Decide and record the source of truth: **worker copy is canonical** (production path). Update the header comment in each src/lib file to state it mirrors the worker copy and lists the single allowed diff (import alias + "server"/"worker" wording + 502 `status`).

**Step 2:** Apply Task 1–6 changes to **both copies identically**, preserving the per-copy import alias and wording differences. (If re-exporting is chosen — recommended long-term — make `src/lib/pexels-broll.js` re-export from the worker path and update the vision/test imports accordingly; then only the worker copy carries logic.)

**Step 3:** Run the full test suite — the `__tests__/` imports pull from `src/lib/`, so this step proves the two stay behaviorally identical.

**Done when:** `npm run test` passes; a `git diff --stat` shows both copies changed in lock-step (or src/lib now re-exports worker); no test imports a stale symbol.

---

### Task 8: Tests + fixtures

**Files:**

- Modify/Create: `__tests__/pexels-broll.test.js`, `__tests__/visual-continuity.test.js` (or new `__tests__/broll-providers.test.js`)

**Step 1:** Unit-test `providerOrderForStyle` (D5 table), `normalizeVisualStyle`/`normalizePurpose` defaults (F7 — assert `normalizeVisualStyle(undefined) === null` and `normalizeVisualStyle("cartoon") === "cartoon"` so T6's purpose fallback can fire), and `toAsset` normalization for a Pixabay vs Pexels response shape.

**Step 2:** Add the **one seam test** (D11): mock `fetch` so Pixabay returns an `animation` result, call `fetchBrollForQueries` with `visualStyle: "cartoon"`, and assert (a) Pixabay hit first, (b) beats carry `provider`/`providerAssetId`, (c) total-floor behavior (SOFT SKIP) when style beats are sparse, and (d) `styleDegraded`/`styleAcceptanceRate` are returned and reflect the sparse on-style count (D15).

**Step 3:** Add failure-mode tests: rate-limit floor causes swap (F2), missing Pixabay key degrades to Pexels without throwing (F1), strict-tier style mismatch rejects then style-retries, capped at `MAX_STYLE_RETRIES` before a betterQuery round (F3/F6), the `MAX_VISION_CALLS_PER_RENDER` cap short-circuits further verifies while the render still completes via `pickUnusedClip`/best-rejected (F12), and `styleDegraded`/`styleAcceptanceRate` set when on-style beats < `MIN_VISUAL_BEATS` (F13/D15).

**Done when:** `npm run test` passes; the new tests cover D5, D11, D12 and F1–F6.

---

### Task 9: Document the Pixabay key + license note

**Files:**

- Modify: `worker/README.md` (or equivalent env doc)

**Step 1:** Document `PIXABAY_API_KEY` (optional; when absent the worker routes Pexels-only), its signup source, and the concrete terms verified 2026-08-27 (not deferred): default **100 req/60s** per key; "requests must be cached for 24 hours"; "systematic mass downloads are not allowed"; "do not send lots of automated queries"; "permanent hotlinking … is not allowed" (we pass files to FFmpeg, never hotlink).

**Step 2:** Add the licensing note — answered now, not punted: clips are stored only as `provider` + `providerAssetId`; Pexels free license and Pixabay Content License permit unattributed commercial use for rendering AI videos. Pixabay asks that attribution be shown "whenever search results are displayed" — not triggered here (end users never see result thumbnails). Media handling stays render-time: 24h search cache + per-render media dedupe only (D7/T4); the *persistent*-library question remains out of scope (NOT in scope) and is the only item to re-check if durable storage is ever added.

**Done when:** a developer can configure the key and understand the fallback + licensing posture from the README without reading code.

---

### Task 10: Request surface — Visual style picker + `/api/generate` threading + purpose auto-derivation

**Files:**

- Modify: `src/lib/render-constants.js`
- Modify: `src/app/api/generate/route.js`
- Modify: `src/components/CreatorWorkspace.js`
- Create: `__tests__/visual-style.test.js`

**Interfaces:**

- Consumes: the 10 canonical style ids pinned in Task 1 (`worker/pipeline/prepare/video-taxonomy.js`) — mirrored here as `VISUAL_STYLES`.
- Produces: `VISUAL_STYLES`, `VISUAL_STYLE_IDS`, `resolveVisualStyle`, `PURPOSE_BY_TONE`, `resolvePurpose` in `@/lib/render-constants`; a Supabase `payload` that always carries `purpose` and carries `visualStyle` only when the user picks a style (Auto → omitted, F7).

**Step 1:** Add the style + purpose constants to `src/lib/render-constants.js`, below `ASPECT_RATIO_IDS` (line 260).

```js
/** Visual styles — lowercase-with-spaces canonical ids (Keep in sync with worker/pipeline/prepare/video-taxonomy.js, F11). */
export const VISUAL_STYLES = [
  { id: "realistic", label: "Realistic", blurb: "True-to-life footage — documentary, how-to, everyday moments." },
  { id: "cinematic", label: "Cinematic", blurb: "Film look — golden hour, shallow depth of field, dramatic framing." },
  { id: "cartoon", label: "Cartoon", blurb: "Playful illustrated look — bold shapes, flat color." },
  { id: "2d animation", label: "2D Animation", blurb: "Flat vector motion — explainer and infographic energy." },
  { id: "3d animation", label: "3D Animation", blurb: "Rendered 3D worlds and objects." },
  { id: "motion graphics", label: "Motion Graphics", blurb: "Kinetic typography and abstract shapes." },
  { id: "anime/comic", label: "Anime / Comic", blurb: "Manga and comic-panel styling." },
  { id: "horror/dark", label: "Horror / Dark", blurb: "Moody, shadowed, dread-forward frames." },
  { id: "minimal", label: "Minimal", blurb: "Clean, sparse compositions — lots of negative space." },
  { id: "vintage", label: "Vintage", blurb: "Retro film grain and period look." },
];

export const VISUAL_STYLE_IDS = VISUAL_STYLES.map((s) => s.id);

/**
 * Resolve a posted visual style. Returns the canonical id, null when unset/Auto
 * (route omits the field), or undefined when an unknown non-empty value is
 * posted (route returns 400).
 * @param {unknown} value
 * @returns {string | null | undefined}
 */
export function resolveVisualStyle(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (raw === "" || raw.toLowerCase() === "auto") return null;
  const id = raw.toLowerCase();
  if (VISUAL_STYLE_IDS.includes(id)) return id;
  return undefined;
}

/** Auto-derived purpose from narration tone — never a manual picker (D13). */
export const PURPOSE_BY_TONE = {
  Moody: "horror/story recap",
  Corporate: "product promotion",
  Cinematic: "documentary",
  Playful: "social/news",
  Urgent: "motivation",
  Educational: "educational",
  Storyteller: "storytelling",
  Luxurious: "product promotion",
};

/**
 * @param {string} [tone]
 * @returns {string} a D2 purpose value
 */
export function resolvePurpose(tone) {
  return PURPOSE_BY_TONE[tone] || "storytelling";
}
```

**Step 2:** Thread `visualStyle` + `purpose` through `src/app/api/generate/route.js`.

- Add `VISUAL_STYLE_IDS`, `resolveVisualStyle`, and `resolvePurpose` to the existing `@/lib/render-constants` import (lines 9-19).
- After the `aspectRatio` read (line 43), add:

```js
    const visualStyle = resolveVisualStyle(body?.visualStyle);
    const purpose = resolvePurpose(tone);
```

- Below the `aspectRatio` 400 check (lines 67-72), add:

```js
    if (visualStyle === undefined) {
      return NextResponse.json(
        {
          error: `visualStyle must be one of: ${VISUAL_STYLE_IDS.join(", ")} (or "auto"/omit).`,
        },
        { status: 400 }
      );
    }
```

- Add both fields to the `payload` object (lines 104-112):

```js
    const payload = {
      topic,
      tone,
      subtitleTheme,
      voice,
      captionsEnabled,
      targetDurationSeconds,
      aspectRatio,
      // Auto/absent → omit visualStyle so the worker resolves via PURPOSE_STYLE_DEFAULT (F7)
      ...(visualStyle ? { visualStyle } : {}),
      purpose,
    };
```

**Step 3:** Add the picker to `src/components/CreatorWorkspace.js`.

- Extend the `@/lib/render-constants` import (lines 13-19) with `VISUAL_STYLES`.
- Below `VIDEO_TONE_OPTIONS` (lines 32-36), add:

```js
const VIDEO_STYLE_OPTIONS = [
  { id: "", blurb: "Auto — match the look to your topic automatically." },
  ...VISUAL_STYLES.map(({ id, blurb }) => ({ id, blurb })),
];
```

- Add state next to `tone` (line 341): `const [visualStyle, setVisualStyle] = useState("");`
- Post it in `handleGenerate` (lines 810-818): add `visualStyle: visualStyle || undefined,` to the body.
- Render the picker directly after the tone `<section>` (lines 1059-1072), reusing `variant="tone"`:

```jsx
              <section className="relative z-20 glass-card rounded-2xl p-5 sm:p-6">
                <HoverSelect
                  label="Visual style"
                  hint="Pick the footage look. Leave on Auto to match the topic."
                  value={visualStyle}
                  options={VIDEO_STYLE_OPTIONS}
                  disabled={isBusy}
                  variant="tone"
                  onChange={(next) => setVisualStyle(next)}
                />
              </section>
```

**Step 4:** Write the unit test `__tests__/visual-style.test.js` and run it.

```js
import { describe, expect, it } from "vitest";
import {
  VISUAL_STYLES,
  VISUAL_STYLE_IDS,
  PURPOSE_BY_TONE,
  resolveVisualStyle,
  resolvePurpose,
} from "@/lib/render-constants";

describe("visual style ids", () => {
  it("pins exactly the 10 canonical lowercase-with-spaces ids", () => {
    expect(VISUAL_STYLE_IDS).toEqual([
      "realistic",
      "cinematic",
      "cartoon",
      "2d animation",
      "3d animation",
      "motion graphics",
      "anime/comic",
      "horror/dark",
      "minimal",
      "vintage",
    ]);
    expect(VISUAL_STYLES).toHaveLength(10);
    expect(VISUAL_STYLES.every((s) => s.id && s.label && s.blurb)).toBe(true);
  });

  it("resolveVisualStyle normalizes casing, omits Auto, rejects unknown", () => {
    expect(resolveVisualStyle("cartoon")).toBe("cartoon");
    expect(resolveVisualStyle("2D ANIMATION")).toBe("2d animation");
    expect(resolveVisualStyle("auto")).toBeNull();
    expect(resolveVisualStyle("")).toBeNull();
    expect(resolveVisualStyle(undefined)).toBeNull();
    expect(resolveVisualStyle("not-a-style")).toBeUndefined();
  });

  it("resolvePurpose maps every tone and falls back to storytelling", () => {
    expect(resolvePurpose("Moody")).toBe("horror/story recap");
    expect(resolvePurpose("Corporate")).toBe("product promotion");
    expect(resolvePurpose("Cinematic")).toBe("documentary");
    expect(resolvePurpose("Playful")).toBe("social/news");
    expect(resolvePurpose("Urgent")).toBe("motivation");
    expect(resolvePurpose("Educational")).toBe("educational");
    expect(resolvePurpose("Storyteller")).toBe("storytelling");
    expect(resolvePurpose("Luxurious")).toBe("product promotion");
    expect(resolvePurpose("UnknownTone")).toBe("storytelling");
    expect(PURPOSE_BY_TONE).toHaveProperty("Educational", "educational");
  });
});
```

Run: `npx vitest run __tests__/visual-style.test.js` → all pass.

**Step 5:** Commit.

```bash
git add src/lib/render-constants.js src/app/api/generate/route.js src/components/CreatorWorkspace.js __tests__/visual-style.test.js
git commit -m "feat: add Visual style picker and thread visualStyle/purpose through /api/generate"
```

**Done when:** `npm run test` passes (new + existing). Manual smoke: `POST /api/generate` with `visualStyle:"cartoon"` enqueues a row whose `payload.visualStyle === "cartoon"` and `payload.purpose === "documentary"` (default Cinematic tone); with `visualStyle:"auto"` (or omitted) the row's `payload` has **no** `visualStyle` key but a populated `purpose`; with `visualStyle:"bogus"` the route returns 400. The workspace shows a **Visual style** dropdown directly after **Video tone** and posts the picked id.

---

## Suggested implementation order

```
  T1 taxonomy ──► T2 providers ──► T3 router ──► T4 rate-limit/cache
        │                                      │
        ├────────────► T5 query-gen ◄──────────┘
        │                │
        │                ▼
        │             T6 seam caller (index.js + beat shape)
        │                │
        │     ┌──────────┴───────────┐
        │     ▼                      ▼
        │  T7 duplication sync     T8 tests ──► (T9 docs can run anytime after T2)
        │     │
        │     ▼
        └─► T10 request surface (Lane D: starts after T1; own worktree)
                 │
                 └────────────────────► npm run test  ✓
```

Sequential through T6 (shared `worker/pipeline/prepare/`). T8 and T9 parallelize after T6; T9 may start after T2. **T10 starts as soon as T1 pins the style-id list** and runs in its own worktree (Lane D) — it touches only `src/app`, `src/components`, and `src/lib/render-constants.js`.

## Definition of done (release)

- [ ] `npm run test` passes with the new unit + seam tests (T8).
- [ ] `PURPOSE` / `VISUAL_STYLE` enums + `PURPOSE_STYLE_DEFAULT` / `STYLE_QUERY_VOCAB` ship (T1).
- [ ] `fetchBrollForQueries` signature unchanged; internally routes Pexels+Pixabay per style (T2, T3).
- [ ] Orientation maps via a per-provider adapter (`portrait`→Pexels `portrait` / Pixabay `vertical`; `landscape`→`landscape` / `horizontal`; `square`→no-param / decided fallback); Pixabay compatibility verified against current docs with a `min_width`/`min_height` or dim-based filter fallback — no verbatim `orientation` passthrough (T2 Step 2).
- [ ] Animated tier hits Pixabay `video_type=animation` first; other styles hit Pexels first (D5, T3).
- [ ] Strict-style tier rejects style-mismatched clips via an independent `styleMatch` verdict (`STYLE_MATCH_THRESHOLD` 0.4, `MAX_STYLE_RETRIES` 2) while relevance `match` stays on `CLIP_MATCH_THRESHOLD` 0.6; SOFT SKIP drops the style floor, keeps total floor (D6, T3).
- [ ] Per-render vision calls capped at `MAX_VISION_CALLS_PER_RENDER` (30); `prepare_broll_ok` logs `style_acceptance_rate`/`style_degraded` and `payload.styleDegraded`/`styleAcceptanceRate` are persisted when on-style beats < `MIN_VISUAL_BEATS` (D15, T3, T6).
- [ ] Rate headers read per provider (correct `X-Ratelimit-*` vs `X-RateLimit-*` casing), Pixabay ≤ 1 req/s ceiling + backoff + swap active; 24h search cache and per-render media cache (keyed by `providerAssetId`) active; no limit bypass (D7, T4).
- [ ] `planVisualBeats` accepts style and injects vocab; deprecated `deriveVisualQueries` still valid (T5).
- [ ] `payload.visualStyle` / `payload.purpose` persisted (visualStyle resolved with the purpose → `PURPOSE_STYLE_DEFAULT` fallback per D14); each beat stores `provider` + `providerAssetId` (D4, T6).
- [ ] Missing `PIXABAY_API_KEY` degrades to Pexels-only with a `provider_unavailable` log, no throw (D12, T2).
- [ ] src/lib and worker copies remain in lock-step (or src/lib re-exports worker) with no test importing stale symbols (T7).
- [ ] README documents the Pixabay key + licensing posture (T9).
- [ ] Visual style is reachable end-to-end: `CreatorWorkspace` posts the picked id, `route.js` 400s on unknown ids, and a picked style persists on the row's `payload` (Auto/absent → the field is omitted, F7) (D13, T10).
- [ ] `payload.purpose` is auto-derived from tone via `PURPOSE_BY_TONE` with no purpose picker anywhere in the UI, and persists on every enqueue row (D13, T10).

## Retrospective learning

- Prior commits (`feat: implement bounded concurrency for Pexels B-roll fetching`, `feat: refactor video generation pipeline for improved script drafting and B-roll fetching`) show the B-roll seam was **recently and deliberately hardened** (bounded concurrency, speed-first vision budget). This plan deliberately preserves that seam and its concurrency/retry semantics rather than rebuilding them — the same area was touched last cycle, so keep changes additive and signature-compatible.
- The prior render-queue plan (2026-08-24) already introduced "line-bound B-roll + gpt-4o-mini clip verify + 1 retry"; that's the foundation this plan extends, not a separate pipeline.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | — | not run | — |
| Codex Review | `/codex review` | Independent 2nd opinion | — | not run | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open (FULL_REVIEW, commit 6c245aa) | 17 issues, 2 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | — | not run | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | — | not run | — |

**VERDICT:** Eng Review issues_open — 2 critical gaps (F5 src/lib↔worker drift, F6 signature drift) mapped to T1+T7; eng review required before ship. A manual product-surface audit found the original style taxonomy **dormant** (the form and `/api/generate` carried no `visualStyle`/`purpose`), and closed it as D13 + T10 — so the taxonomy now ships reachable through the picker, not just as worker-internal enums.

NO UNRESOLVED DECISIONS
