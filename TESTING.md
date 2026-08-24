# Testing

This project uses **Vitest + React Testing Library** for unit/component tests and **Playwright** for end-to-end tests.

## Unit & component tests

Run once (CI mode):

```bash
npm run test
```

Watch mode:

```bash
npm run test:watch
```

Test files live in `__tests__/` and match `*.test.{js,jsx}`. Configuration is in `vitest.config.mjs` (jsdom environment, `@` aliased to `./src`).

## End-to-end tests

Playwright drives a real browser against the app:

```bash
npm run test:e2e
```

Playwright reuses an already-running dev server on `http://localhost:3000`, or starts its own via the `webServer` config. E2E specs live in `e2e/`.

## Render worker

Real pipeline (TTS + FFmpeg via `ffmpeg-static`):

```bash
# Create public Storage bucket "renders" in Supabase (once)
cd worker && npm install && npm run dev   # STUB_RENDER=0
# OPENAI_API_KEY from worker/.env or ../.env.local
```

Stub-only queue test: `STUB_RENDER=1 npm run dev` in `worker/`.

## CI

The `.github/workflows/test.yml` workflow runs `npm run test` on push to `main` and on pull requests.