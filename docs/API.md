# API contract

This file is the shared contract between `web/` and `api/`. Do not change it without asking the human.

## POST /api/check

Checks management claims against proof documents and returns one finding per claim.

### Request

`multipart/form-data` with these fields:

| Field          | Type             | Required                                | Notes                                                  |
| -------------- | ---------------- | --------------------------------------- | ------------------------------------------------------ |
| `claims_files` | file, repeatable | one of `claims_files` or `claims_text`  | One or more files. Allowed types: `txt`, `pdf`.        |
| `claims_text`  | string           | one of `claims_files` or `claims_text`  | Pasted claims text, used instead of files.             |
| `proof_files`  | file, repeatable | yes                                     | One or more files. Allowed types: `txt`, `pdf`, `csv`. |
| `ticker`       | string           | no                                      | Optional stock ticker.                                 |

### Response 200

`Content-Type: application/json`

```ts
{
  "company": string,
  "period": string,
  "findings": [
    {
      "id": string,
      "claim": string,
      "claim_source": { "name": string, "quote": string },
      "label": "supported" | "discrepancy" | "insufficient",
      "proof_source": { "name": string, "quote": string, "url": string | null } | null,
      "claimed_usd": string | null,
      "proof_usd": string | null,
      "gap_usd": string | null,
      "gap_pct": string | null,
      "priority": "high" | "medium" | "low",
      "next_action": string
    }
  ],
  "sources": [
    { "name": string, "type": "upload" | "sec", "date": string | null, "url": string | null }
  ]
}
```

### Errors

Errors return status `400` (bad input) or `500` (server failure) with this body:

```json
{ "error": "string" }
```

### Rules

- Money values (`claimed_usd`, `proof_usd`, `gap_usd`) are decimal strings in USD, for example `"1250000.00"`. Never floats.
- `gap_pct` is also a decimal string, for example `"6.00"`.
- A `quote` must appear word for word in its source text.

## Mock response

The starter case lives in [`docs/mock-response.json`](./mock-response.json).

Inputs:

- Management claims: revenue `1250000.00`, cash `480000.00`, debt `900000.00`, and "all material contracts are signed".
- Finance report: revenue `1175000.00`, cash `410000.00`, debt `900000.00`.
- Contract `CT-102` is unsigned.

Expected labels:

| Claim     | Label         | Gap                   |
| --------- | ------------- | --------------------- |
| Revenue   | `discrepancy` | `75000.00` (`6.00`%)  |
| Cash      | `discrepancy` | `70000.00` (`14.58`%) |
| Debt      | `supported`   | `0.00` (`0.00`%)      |
| Contracts | `discrepancy` | `CT-102` unsigned     |
