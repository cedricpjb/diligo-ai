# API contract

This file is the shared contract between `web/` and `api/`. Do not change it without asking the human.

## POST /api/check

Checks management claims against proof documents and returns one finding per claim.

### Request

`multipart/form-data` with these fields. At least one of `claims_files`, `claims_text` or `claims_audio` is required.

| Field          | Type             | Required | Notes                                                                 |
| -------------- | ---------------- | -------- | --------------------------------------------------------------------- |
| `claims_files` | file, repeatable | see above | One or more files. Allowed types: `txt`, `pdf`.                      |
| `claims_text`  | string           | see above | Pasted claims text.                                                  |
| `claims_audio` | file, repeatable | see above | One or more audio files. Allowed types: `mp3`, `wav`, `m4a`.         |
| `proof_files`  | file, repeatable | yes      | One or more files. Allowed types: `txt`, `pdf`, `csv`.                |
| `ticker`       | string           | no       | Optional stock ticker.                                                |

Audio in `claims_audio` is transcribed by the backend with ElevenLabs speech-to-text. The transcript is treated as claim text.

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
      "claim_source": {
        "name": string,
        "quote": string,
        "timestamp_start": number | null,
        "timestamp_end": number | null,
        "speaker": string | null
      },
      "label": "supported" | "discrepancy" | "insufficient",
      "decision": "YES" | "NO" | "NEEDS_REVIEW",
      "jev_probability": number | null,
      "explanation": string,
      "proof_source": { "name": string, "quote": string, "url": string | null } | null,
      "claimed_usd": string | null,
      "proof_usd": string | null,
      "gap_usd": string | null,
      "gap_pct": string | null,
      "priority": "high" | "medium" | "low",
      "next_action": string,
      "mocked": boolean
    }
  ],
  "sources": [
    { "name": string, "type": "upload" | "sec", "date": string | null, "url": string | null }
  ],
  "transcript": {
    "segments": [
      { "source": string, "start": number, "end": number, "speaker": string | null, "text": string }
    ]
  } | null
}
```

### Finding fields

- `label` and `decision` always agree:

  | `label`        | `decision`     |
  | -------------- | -------------- |
  | `supported`    | `YES`          |
  | `discrepancy`  | `NO`           |
  | `insufficient` | `NEEDS_REVIEW` |

- `jev_probability` is a number between 0 and 1, or `null` when Jev was not called.
- `explanation` is one or two plain sentences written by the reasoning model. It is never used for math.
- `claim_source.timestamp_start` and `claim_source.timestamp_end` are seconds into the audio. They are `null` when the claim did not come from audio. `speaker` is `null` when unknown or when the claim did not come from audio.
- `mocked` is `true` when the finding used mock results (see Mock mode), otherwise `false`.

### Transcript

`transcript` is `null` when no `claims_audio` was sent. Each segment's `source` is the filename of the audio file it came from, and matches a `name` in `sources`. `start` and `end` are seconds into that audio file.

### Decision rules

a. Deterministic checks set the decision and matching label directly. Numeric claims use code-computed money gaps after normalizing units and periods: a match gives YES and a mismatch gives NO. If the claim is rounded, it matches when the evidence rounds to it. A quote that cannot be verified word for word in its source gives NEEDS_REVIEW, overriding any earlier decision.

b. Contract status is deterministic: any matching register entry marked unsigned gives NO; if none is unsigned but any signing status is unknown, the decision is NEEDS_REVIEW. These decisions hold regardless of Jev's probability. A Jev probability may be retained in the response, but its thresholds cannot override these checks.

c. Only text claims with no deterministic decision use Jev thresholds. Jev answers one yes or no question per claim and evidence passage: probability at or above 0.80 gives YES, at or below 0.20 gives NO, anything between gives NEEDS_REVIEW. These thresholds are configurable and have not been validated.

d. No matching evidence found: NEEDS_REVIEW, and Jev is not called.

e. Jev never receives raw audio, PDFs or images. Only text.

### Mock mode

If a service key (`JEV_API_KEY`, `ELEVENLABS_API_KEY` or `ANTHROPIC_API_KEY`) is missing, the backend uses clearly labeled mock results instead of calling that service, and sets `"mocked": true` on each finding that used them.

### Errors

Errors return status `400` (bad input) or `500` (server failure) with this body:

```json
{ "error": "string" }
```

### Rules

- Money values (`claimed_usd`, `proof_usd`, `gap_usd`) are decimal strings in USD, for example `"1250000.00"`. Never floats.
- `gap_pct` is also a decimal string, for example `"6.00"`.
- A `quote` must appear word for word in its source text. For audio, the source text is the transcript.

## Mock response

The starter case lives in [`docs/mock-response.json`](./mock-response.json).

Inputs:

- Management claims (spoken on a call, `management_call.m4a`): revenue `1250000.00`, cash `480000.00`, debt `900000.00`, and "all material contracts are signed".
- Finance report: revenue `1175000.00`, cash `410000.00`, debt `900000.00`.
- Contract `CT-102` is unsigned.

Expected results:

| Claim     | Label         | Decision | Gap                   | `jev_probability` |
| --------- | ------------- | -------- | --------------------- | ----------------- |
| Revenue   | `discrepancy` | `NO`     | `75000.00` (`6.00`%)  | `null`            |
| Cash      | `discrepancy` | `NO`     | `70000.00` (`14.58`%) | `null`            |
| Debt      | `supported`   | `YES`    | `0.00` (`0.00`%)      | `null`            |
| Contracts | `discrepancy` | `NO`     | `CT-102` unsigned     | `0.04`            |

The contracts `jev_probability` of `0.04` is an illustrative value, not a real Jev output. That finding is marked `"mocked": true` for this reason.
