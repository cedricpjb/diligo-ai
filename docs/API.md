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

#### Plain-text contract register format

Registers may list multiple `ID signed` or `ID unsigned` entries on one line,
separated by semicolons, with introductory text and a trailing `as of Month D, YYYY`
snapshot date applying to the whole line. For example: `CT-100 signed; CT-101 signed; CT-102 unsigned as of September 30, 2026.`
For contract-status checks, a snapshot dated on a calendar quarter's final day
matches that quarter in the same year (September 30, 2026 matches 2026 Q3).
The original register line and uploaded filename are retained as the proof quote
and source name; the deterministic contract-status rule below is unchanged.

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
      "mocked": boolean,
      "start_ms"?: number | null,
      "end_ms"?: number | null,
      "audio_file_id"?: string
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
- `start_ms` and `end_ms` are optional integers: milliseconds into the audio where the claim is spoken. They are present only on findings whose claim came from audio, and `null` when the timing is unknown. They are absent (or `null`) for text claims, and clients should treat absent and `null` the same.
- `audio_file_id` is an optional string that identifies the uploaded recording for `GET /api/clip`. It is present only on findings whose claim came from audio and whose recording was kept (see Retention under `GET /api/clip`).
- `mocked` is `true` when the finding used mock results (see Mock mode), otherwise `false`.

### Transcript

`transcript` is `null` when no `claims_audio` was sent. Each segment's `source` is the filename of the audio file it came from, and matches a `name` in `sources`. `start` and `end` are seconds into that audio file.

### Decision rules

a. Deterministic checks set the decision and matching label directly. Numeric claims use code-computed money gaps after normalizing units and periods: a match gives YES and a mismatch gives NO. If the claim is rounded, it matches when the evidence rounds to it. A quote that cannot be verified word for word in its source gives NEEDS_REVIEW, overriding any earlier decision. Quotes that are names, speaker or job titles, headings, document titles, topic phrases, questions, or fragments without a subject and a verb or a definite metric value/status are discarded before checking.

b. Contract status is deterministic: any matching register entry marked unsigned gives NO; if none is unsigned but any signing status is unknown, the decision is NEEDS_REVIEW. These decisions hold regardless of Jev's probability. A Jev probability may be retained in the response, but its thresholds cannot override these checks.

c. Only complete, concrete text assertions with a number, date, or named item or event and no deterministic decision use Jev thresholds; opinion or outlook wording gives NEEDS_REVIEW with the reason "Subjective statement, not verifiable from the proof". Jev answers one yes or no question per claim and relevant evidence passage: probability at or above 0.80 gives YES only for a complete assertion; all lower probabilities give NEEDS_REVIEW. At or below 0.20, the reason is "Jev found no support in the proof". A Jev probability alone never gives NO, including for signed-register evidence; NO requires a deterministic contradiction such as a code-computed amount or percentage mismatch or an unsigned contract entry. These thresholds are configurable and have not been validated.

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

## GET /api/clip

Returns a short audio segment for a finding that came from audio. Use the finding's `audio_file_id` as `file`, and its `start_ms` and `end_ms` as the offsets.

### Request

Query parameters. Each must appear exactly once; any other parameter is rejected.

| Parameter  | Type    | Required | Notes                                                                                                     |
| ---------- | ------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `file`     | string  | yes      | The `audio_file_id` from a finding. It is an ID issued by the backend, never a path or a filename.          |
| `start_ms` | integer | yes      | Whole milliseconds, 0 or more.                                                                            |
| `end_ms`   | integer | yes      | Whole milliseconds. Must be greater than `start_ms`, at most 60,000 after it, and not past the end of the recording. |

### Response 200

The audio bytes, with these headers:

| Header           | Value                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| `Content-Type`   | `audio/wav` for `segment`, otherwise the type of the uploaded file.     |
| `X-Clip-Start-Ms` | The requested `start_ms`.                                             |
| `X-Clip-End-Ms`   | The requested `end_ms`.                                               |
| `X-Clip-Mode`     | `segment` or `whole-file`.                                            |

- `segment`: a WAV file containing only the requested span.
- `whole-file`: the whole original recording, returned because the backend could not cut the span. The client must seek to `X-Clip-Start-Ms` and stop at `X-Clip-End-Ms`. `m4a` recordings are always returned this way.

### Errors

Status `400` with `{ "error": "string" }` for:

- A bad ID: `file` is not a valid ID, or it is not an ID the backend issued (unknown or expired). Path traversal such as `../x`, absolute paths and Windows paths are never read as paths; they are rejected as bad IDs.
- Malformed parameters: a missing, repeated or unknown parameter, or an offset that is not a whole, non-negative number.
- Bad range: `end_ms` is not greater than `start_ms`, or the span is longer than 60 seconds.
- Out of range: the range starts or ends past the end of the recording, wholly or partly. This is checked in both modes.
- A method other than `GET`.

Status `500` with the same body if the backend could not cut the span.

### Retention

Recordings are kept in memory only and are never written to disk. A recording expires one hour after its upload, and the backend keeps at most 100 recordings at a time: a `POST /api/check` that uploads audio while 100 are held returns `400`. Recordings are lost when the backend restarts. A recording whose duration cannot be read is not kept, and its findings have no `audio_file_id`.

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
