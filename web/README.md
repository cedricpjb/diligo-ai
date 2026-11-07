# Diligo.ai web

Next.js (App Router), TypeScript, Tailwind CSS v4 and shadcn/ui. Dark theme only, per `docs/DESIGN.md`.

## Run

```bash
cd web
npm install
npm run dev        # http://localhost:3000
```

Without `NEXT_PUBLIC_API_URL`, the app serves the starter case from `docs/mock-response.json`
(the sidebar says "Sample data"). To use the backend, put this in `web/.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000
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
- `lib/files.ts`: upload rules (allowed types, size limits, duplicates).
- `scripts/sync-mock.mjs`: copies `docs/mock-response.json` into `lib/generated/` (git-ignored)
  before dev, build and type checks, because Next.js cannot import files outside `web/`.
- `components/shell`: sidebar and header. `components/investigation`: the New Investigation screen.
