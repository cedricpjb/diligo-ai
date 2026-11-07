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
The server binds to `127.0.0.1:3001`; CORS permits `http://localhost:3000`.

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
- `JEV_API_KEY`: absent/blank selects a deterministic probability mock.
- `ELEVENLABS_API_KEY`: absent/blank selects the explicitly mocked starter-call
  transcript for each uploaded audio file. This demo transcript does **not**
  describe the actual audio; findings derived from it are marked mocked.
- `ANTHROPIC_API_KEY`: reserved for the later Claude implementation. This stage
  uses `extractClaims` and deterministic explanation templates even if a key is
  present. The templates stand in for the reasoning service, so **all current
  findings have `mocked: true`**. Numeric decisions and amounts are still computed
  from the uploaded evidence. This differs intentionally from the static fixture's
  numeric mock flags, which assume real reasoning/transcription.
- `JEV_YES_THRESHOLD` / `JEV_NO_THRESHOLD` (defaults `0.80` / `0.20`), finite values
  in `[0, 1]`, with NO strictly below YES. These thresholds are unvalidated.

No keys or document contents are logged. Uploads stay in memory; no source files
are written to disk. Upstream exceptions are replaced with generic errors.
With a configured service key, request failures return 500; they never silently
become fabricated successful results. Service modules accept injected transports
for offline testing. The test suite blocks all real external fetches, never reads
local credentials, and never makes a paid API call.

## Supported input

- Claim text, UTF-8 `.txt`, extractable-text `.pdf`, and `.mp3` / `.wav` / `.m4a`
  audio. Proof files accept UTF-8 `.txt`, `.csv`, and text `.pdf`.
- Regex extraction recognizes revenue, cash (including cash on hand), debt
  (including total debt), and affirmative `contracts are signed` claims. The
  single `extractClaims(source)` boundary is ready to replace with Claude later.
  Unsupported prose is not interpreted. No recognized claims returns 400.
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
The contract leaves these details unspecified; this implementation uses:

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
   require review. Otherwise thresholds determine the decision. The observed Jev
   probability is retained; the mock uses illustrative `0.04` for unsigned and
   `0.96` for signed evidence. No matching evidence means NEEDS_REVIEW without Jev.
5. **Quotes:** every claim/proof quote is checked by exact substring membership in
   the named original text or transcript. Invalid quotes force NEEDS_REVIEW and
   `insufficient`, regardless of an earlier decision. PDF source text means the
   parser's extracted text. Uploaded instructions are always treated as data.

The API contract also does not define company/period fallback metadata, upload
limits, unsupported-language behavior, register column schemas, or the precedence
of explicit register contradictions over Jev. The choices above are documented
here without changing the shared contract.

## Service references and remaining limits

Real clients follow the official documentation read before implementation:

- [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart) and
  [Noul](https://docs.typesafe.ai/primitives/noul): text state and one yes/no question
  to `/v1/systemone`; parse `answers.supported.noul`. Thresholds live in checking
  code, outside the Jev module. No audio, PDFs, or images are sent to Jev.
- [ElevenLabs create transcript](https://elevenlabs.io/docs/api-reference/speech-to-text/convert):
  multipart audio to `/v1/speech-to-text`, `scribe_v2`, diarization and word timing;
  source-preserving segments grouped by speaker. No browser calls these services.

Live vendor calls have not been exercised. Claude extraction/explanations, OCR,
SEC retrieval, general financial-table parsing, fiscal calendars, currency
conversion, and production authentication/rate limiting are not implemented.
The server is intended for the local frontend and has no public deployment setup.
