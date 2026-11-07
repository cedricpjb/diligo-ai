# Challenge 1 UI integration test

Tested on 2026-11-07 against `efa124a` using Node 22.23.4 and `playwright-cli`.

**Result: FAIL.** Revenue, cash, and debt meet the acceptance criteria. Contracts
returns NEEDS REVIEW instead of NO for unsigned CT-102. No wiring bug was found;
application code is unchanged because fixes were limited to wiring.

## Setup and reproduction

1. Install locked dependencies with `npm ci` in `api/` and `web/`.
2. With Node 22 active, run `npm run dev` from `api/` (port 3001).
3. In a second PowerShell terminal, from `web/`, run:

   ```powershell
   $env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3001'
   npm.cmd run dev -- --port 3000
   ```

4. Open a dedicated browser:

   ```powershell
   playwright-cli.cmd -s=diligo-integration open http://localhost:3000/new
   playwright-cli.cmd -s=diligo-integration snapshot
   ```

5. Enter `Target 01 - Challenge 1` as the deal name. Use the UI file pickers to
   upload `management-summary.txt` under **What they said**, then
   `finance-report.txt` and `contract-register.txt` under **The proof**. Files
   come from the starter kit's `data/documents/` folder; do not substitute the
   API's separate starter CSV or the frontend sample response.
6. Click **Analyze** and inspect Results, including the contracts evidence drawer.
   Use `playwright-cli ... requests` and `response-body <request-number>` to
   inspect the actual API response.

## Observed results

| Claim | Expected Results | Actual Results | Check |
| --- | --- | --- | --- |
| Revenue | NO; $75,000.00 / 6.00% | NO; $75,000.00 / 6.00% | PASS |
| Cash | NO; $70,000.00 / 14.58% | NO; $70,000.00 / 14.58% | PASS |
| Debt | YES | YES; $0.00 / 0.00% | PASS |
| Contracts | NO; CT-102 unsigned | NEEDS REVIEW; no matching evidence | FAIL |

The browser posted to `http://127.0.0.1:3001/api/check` and received HTTP 200.
All three uploaded filenames appear in `sources`. The contracts finding has
`proof_source: null`, `jev_probability: null`, and explanation
`No matching evidence was found.` The drawer agrees, and the Sources panel says
`contract-register.txt` is not cited by any finding. All four findings are
explicitly marked mocked. Browser console: zero errors or warnings.

Playwright CLI assertions checked the rendered decision and money cells, then
opened the contracts drawer and checked for CT-102 unsigned evidence. The three
numeric checks passed; both the contracts decision and evidence checks failed.
No browser routes, API responses, or stored investigation results were mocked or
replaced by the test. Money expectations were compared as strings; no money was
calculated by the test.

## Backend diagnosis and scope

Read-only extraction of the original starter documents confirms:

- Every management claim has period `2026-Q3`.
- `contractRows` extracts only `{ id: 'CT-100', signed: true, period: null }`
  from the single-line register containing CT-100, CT-101, and CT-102.
- `contractRows` in `api/src/extract.ts` uses a single regex match on that line,
  omitting subsequent entries. Its period parser also does not recognize
  `September 30, 2026`.
- The contracts path in `api/src/check.ts` filters rows through `samePeriod`;
  `null` does not match `2026-Q3`, leaving no evidence to check.

Correcting this requires extraction/period behavior changes, beyond the
requested wiring-only scope. The uploaded files and backend decisions were not
altered to manufacture a passing result.

## Other validation and known gaps

- Backend TypeScript build: PASS.
- Existing backend tests under Node 22: 41 passed, 0 failed.
- Frontend TypeScript check: PASS.
- Frontend ESLint: PASS.
- The existing starter backend test uses different, unlabelled CSV input; it
  does not cover this actual starter-kit register format and quarter metadata.
- `docs/API.md` does not specify a contract-register input schema or rules for
  matching quarter-end dates to quarterly claims. The contract is unchanged.
- Live vendor behavior, audio, PDF, and Excel export were outside this UI test.
- `api/.env` was not inspected or printed. No source documents or secrets are
  included in this PR.
