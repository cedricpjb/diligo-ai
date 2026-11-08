# Diligo API

Small Node 22 HTTP server implementing `POST /api/check`. All backend files live
in this directory. The shared contract remains `../docs/API.md`.

## Run

Use Node **22.13 or newer within the 22.x line** (tested on 22.23.4).

```sh
cd api
npm ci
npm test
npm start
```

`npm test` builds TypeScript and runs the native Node test runner. For a build
without tests use `npm run build`; `npm run dev` builds and starts the server.
On PowerShell installations that block npm's script shim, use `npm.cmd`.
The server binds to `127.0.0.1:3001`; CORS permits `http://localhost:3000`, plus any
origin listed in `DEV_CORS_ORIGINS` (see Configuration).

From `api/`, after starting the server:

```sh
curl -F "claims_files=@starter-claims.txt" -F "proof_files=@starter-proof.csv" http://localhost:3001/api/check
```

Use `curl.exe` on Windows. Pasted text uses `-F "claims_text=Revenue USD 1250000.00"`.
Files can be repeated with additional `-F` arguments. The starter response has
cash NO (70000.00, 14.58%), revenue NO (75000.00, 6.00%), contracts NO (CT-102
unsigned), then debt YES. Sorting intentionally follows priority rather than the
illustrative JSON fixture's order.

## Configuration and mock behavior

Create **only `api/.env`** for local configuration; it is already git-ignored.
The application reads this exact file regardless of the working directory.
It never merges shell environment variables, searches parent `.env` files, or
loads keys into the frontend. Available names:

- `PORT` (default `3001`).
- `DEV_CORS_ORIGINS` (optional, local development only): comma-separated browser origins
  allowed in addition to `http://localhost:3000`, for example `http://localhost:3100` for
  the preview. Each entry must be exactly `http://localhost:<port>`; `*`, `https`, other
  hosts, or a trailing slash stop the server with "API configuration is invalid." Leave it
  unset (or blank) for production, where only `http://localhost:3000` is allowed.
- `JEV_API_KEY`: absent/blank selects a deterministic probability mock.
- `ELEVENLABS_API_KEY`: absent/blank selects the explicitly mocked starter-call
  transcript for each uploaded audio file. This demo transcript does **not**
  describe the actual audio; findings derived from it are marked mocked.
- `ANTHROPIC_API_KEY`: enables Claude claim extraction and short explanations.
  Without it, the original regex extractor and deterministic explanations remain
  active, and findings have `mocked: true`. Supply a workspace-scoped API key.
- `JEV_YES_THRESHOLD` / `JEV_NO_THRESHOLD` (defaults `0.80` / `0.20`), finite values
  in `[0, 1]`, with NO strictly below YES. These thresholds are unvalidated.

No keys or document contents are logged. Text, proof and audio uploads stay in
memory and are never written to disk. Upstream exceptions are replaced with generic errors.
Jev and ElevenLabs request failures return 500. Claude invalid JSON, invalid schema,
truncated output, or upstream failures retry once and then fall back to the regex
extractor (or deterministic explanation), explicitly marked `mocked: true`.
An extraction fallback marks every finding in that check as mocked. Service modules accept injected transports
for offline testing. The test suite blocks all real external fetches, never reads
local credentials, and never makes a paid API call.

## Audio timestamps and clips

With `ELEVENLABS_API_KEY` set, uploaded audio goes to ElevenLabs Scribe (`scribe_v2`)
with word timestamps and speaker diarization. Without the key, the explicitly mocked
starter transcript is used and nothing is sent to ElevenLabs. Tests never make live
calls.

Each audio-sourced finding gets two optional fields, `start_ms` and `end_ms`
(integers in milliseconds, `null` when unknown), taken from the words that overlap
the claim's quote, plus an opaque `audio_file_id` for clip playback. Text findings
omit these fields. Mock timings describe the demo transcript, not the uploaded
recording. The fields and the clip route are part of the contract in `docs/API.md`.

`GET /api/clip?file=<audio_file_id>&start_ms=1200&end_ms=4500` returns the span as
WAV when ffmpeg is on the PATH, and otherwise the whole recording. Both carry
`X-Clip-Start-Ms`, `X-Clip-End-Ms` and `X-Clip-Mode` (`segment` or `whole-file`), so a
client can seek and stop at the offsets in whole-file mode. Offsets are whole
milliseconds, at most 60 seconds apart, and must lie inside the recording: the
duration is read from the WAV, MP3 or M4A container when the upload is kept, and a
range that starts or ends past the end is a 400 in both modes. A recording whose
duration cannot be read is not kept, so its findings have no `audio_file_id`.

The clip route never takes a path or filename. `file` must be an ID this process issued
for an upload; anything else, including `../` or absolute paths, is rejected with a 400
before any recording is touched. Recordings are kept in memory and nothing is ever
written to disk, not even a temporary file: ffmpeg receives the recording over stdin
and its output is read from stdout. ffmpeg cannot reliably read M4A from a pipe, so M4A
clips are always served whole rather than written to disk. A recording expires after
one hour, at most 100 are kept (a slot is claimed before an upload is read, so
simultaneous uploads cannot exceed it), and all are gone after a restart.

## Supported input

- Claim text, UTF-8 `.txt`, extractable-text `.pdf`, and `.mp3` / `.wav` / `.m4a`
  audio. Proof files accept UTF-8 `.txt`, `.csv`, and text `.pdf`.
- Claude extraction accepts arbitrary pitch, memo, and transcript prose and returns
  a strict Zod-validated list of money, text, and contract claims. Money metadata
  retains the stated amount, unit, and period as strings; code alone parses money.
  Missing source quotes are dropped before checking and logged only as
  `{ dropped_claims: N }` (no text, filenames, or keys). No retained claims returns 400.
  The fallback regex recognizes revenue, cash, debt, and signed-contract claims.
- Numeric proof matching remains limited to revenue, cash, and debt. Other money
  claims remain NEEDS_REVIEW rather than allowing the model to calculate or decide.
  General text/contract evidence uses conservative line-level word overlap (at
  least two informative words, a unique best passage); Jev handles the decision.
  Ambiguous or absent evidence remains NEEDS_REVIEW. This is not semantic retrieval.
- USD amounts with commas, decimals, K/M/B or thousand/million/billion suffixes,
  `(in thousands)` and equivalent units, or a preceding unit heading.
- Finance CSV rows use `metric,amount[,period]`; quote amounts containing commas.
  Contract CSV accepts `CT-102,unsigned` or a header with `contract_id`/`id`/`contract`
  and `status`/`signed` columns, plus an optional `period` column. Quoted fields and
  semicolon-separated single-line records work. Multi-line fields and arbitrary
  tables are not supported by this small extractor.
- Annual aliases (`FY2025`, `fiscal year 2025`, `2025`), quarter aliases (`Q1 2025`,
  `2025 Q1`), and as-of dates (`2025-12-31`). Use a period heading or CSV period
  column. A heading applies to following rows; explicit row periods take precedence.
  Fiscal/calendar equivalence and annualization are not inferred. Different periods,
  known versus missing periods, ambiguous periods, and conflicting amounts require
  review. Two unlabelled periods may be compared but are reported as unknown.
- An explicit non-USD currency heading is not converted to USD. FX conversion is
  unsupported. Company comes from `Company: ...`, then the optional ticker, then
  `Unknown company`; a ticker does not trigger SEC retrieval.
- Limits: 25 MiB per request, 15 MiB per file, 20 files, 1,000,000 extracted text
  characters per document, 100 PDF pages. Empty, corrupt, encrypted, image-only,
  or unsupported documents return 400. Duplicate filenames are rejected so source
  attribution is unambiguous. Audio has segment-level timestamps and optional
  speakers; a claim inherits the containing segment's bounds.

## Deterministic decisions and contract clarifications

All money is `bigint` cents, including parsing, scaling, gaps, comparison,
rounding, and ranking. JSON money and percentages are decimal strings.
The implementation follows the contract's deterministic decision precedence and
uses these conventions for details that it leaves unspecified:

1. **Rounding:** the final displayed digit defines precision. `$1.25M` rounds
   evidence to USD 10,000; `USD 1250000.00` compares cents; an integer dollar claim
   rounds to dollars. Exact ties round away from zero. Sub-cent amounts are rejected.
2. **Gaps:** absolute claimed-minus-proof difference; percentage uses the absolute
   claimed amount as denominator, rounded to two decimals. A zero claim with nonzero
   proof has `gap_pct: null` because the percentage is undefined; zero/zero is `0.00`.
3. **Priority:** NO before NEEDS_REVIEW before YES. Within each group, sort by exact
   percentage discrepancy, weighting revenue/cash 2x and debt 1x. Undefined nonzero
   zero-base gaps rank first; nonnumeric claims follow numeric discrepancies. NO is
   high, NEEDS_REVIEW medium, YES low. Equal scores retain extraction order.
4. **Registers versus Jev:** explicit unsigned entries are deterministic
   counterexamples and force NO even if Jev disagrees. Unknown register statuses
   require review. Only text claims without a deterministic decision use thresholds.
   The observed Jev probability is retained; the mock uses illustrative `0.04` for unsigned and
   `0.96` for signed evidence. No matching evidence means NEEDS_REVIEW without Jev.
5. **Quotes:** every Claude claim quote is checked by exact substring membership
   in the uploaded source or transcript; invalid claims are dropped. Proof quotes
   are selected by code and checked again before returning findings. PDF source text means the
   parser's extracted text. Uploaded instructions are always treated as data.

The API contract also does not define company/period fallback metadata, upload
limits, unsupported-language behavior, or register column schemas. Those choices
are documented here; deterministic decision precedence is defined in the shared
contract.

## Service references and remaining limits

Real clients follow the official documentation read before implementation:

- [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart) and
  [Noul](https://docs.typesafe.ai/primitives/noul): text state and one yes/no question
  to `/v1/systemone`; parse `answers.supported.noul`. Thresholds live in checking
  code, outside the Jev module. No audio, PDFs, or images are sent to Jev.
- [ElevenLabs create transcript](https://elevenlabs.io/docs/api-reference/speech-to-text/convert):
  multipart audio to `/v1/speech-to-text`, `scribe_v2`, diarization and word timing;
  source-preserving segments grouped by speaker. No browser calls these services.

- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
  and [thinking controls](https://platform.claude.com/docs/en/build-with-claude/thinking):
  `claude-sonnet-5-5`, API version `2026-10-21`, low effort and `between_tools`
  (no tools, so no up-front thinking). Extraction is capped at 4096 output tokens;
  each explanation at 256. Both have a 30-second request timeout and one retry.
  Only claim/proof quotes are sent for explanations, never totals, gaps, or decisions.
  Uploaded text is explicitly untrusted data, not instructions. Explanations do not
  affect computed findings. Long documents can exhaust the cap and use fallback;
  chunking is not implemented. Model prose still requires human review.

No API response fields were added. The contract has only per-finding `mocked`, not
a run-level flag; extraction fallback propagates through those existing flags.
It does not specify extraction schema, retry/token limits, or general passage
retrieval; those internal policies are documented above.

Live vendor calls have not been exercised. OCR,
SEC retrieval, general financial-table parsing, fiscal calendars, currency
conversion, and production authentication/rate limiting are not implemented.
The server is intended for the local frontend and has no public deployment setup.
