# Diligo.ai web

Next.js (App Router), TypeScript, Tailwind CSS v4 and shadcn/ui. Dark theme only, per `docs/DESIGN.md`.

## Run

```bash
cd web
npm install
npm run dev -- --port 3000   # http://localhost:3000 (the API allows this origin)
```

Without `NEXT_PUBLIC_API_URL`, the app serves the starter case from `docs/mock-response.json`
(the sidebar says "Sample data"). To use the backend, put this in `web/.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://127.0.0.1:3001
```

The browser then posts to `${NEXT_PUBLIC_API_URL}/api/check` (see `docs/API.md`). It never calls
ElevenLabs, Jev or Claude, and no API keys live in `web/`.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
```

## Layout

- `lib/api.ts`: the one function, `checkClaims`, that all data goes through.
- `lib/types.ts`: types copied from the contract.
- `lib/export.ts`: Excel export with SheetJS (`xlsx`, installed from the official SheetJS CDN because the npm
  `xlsx` package is stale). Loaded only when Export to Excel is pressed.
- `lib/files.ts`: upload rules (allowed types, size limits, duplicates).
- `scripts/sync-mock.mjs`: copies `docs/mock-response.json` into `lib/generated/` (git-ignored)
  before dev, build and type checks, because Next.js cannot import files outside `web/`.
- `components/shell`: sidebar and header. `components/investigation`: the New Investigation screen.

## Manual check: "Play quote" (audio findings)

The evidence drawer shows "Play quote" only for findings with `audio_file_id`, `start_ms` and `end_ms`
(`components/results/clip-player.tsx`, data call `fetchClip` in `lib/api.ts`). No test framework is set up,
so check it by hand. Run the app with `NEXT_PUBLIC_API_URL` set, put an investigation in
`sessionStorage["diligo:last-investigation"]` whose findings carry those fields, and intercept
`GET {API}/api/clip` in the browser (Playwright `page.route`, serving any WAV with CORS headers that
expose `X-Clip-Mode`). Check each case:

| Case | Setup | Expect |
| --- | --- | --- |
| Text finding | No `audio_file_id` | No "Play quote" button and no audio element. The drawer is unchanged. |
| Audio, cut clip | Response 200, `X-Clip-Mode: segment` | Button reads "Play quote 0:02 to 0:03". Clicking plays from the start. The player does **not** seek. |
| Audio, whole file | Response 200, `X-Clip-Mode: whole-file` | The player jumps to `start_ms / 1000` on load and pauses at `end_ms / 1000`. |
| Expired or bad | Response 400 | Note "Audio clip unavailable. Re-upload the call." No audio element, and the rest of the drawer works. |

The request is `GET {API}/api/clip?file=<audio_file_id>&start_ms=<n>&end_ms=<n>`. The browser console
also logs the 400 itself for the expired case; that is the browser, not the page.
