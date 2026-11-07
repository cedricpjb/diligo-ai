// Types for POST /api/check, copied from docs/API.md (the contract).

export type Label = "supported" | "discrepancy" | "insufficient"
export type Decision = "YES" | "NO" | "NEEDS_REVIEW"
export type Priority = "high" | "medium" | "low"

export interface ClaimSource {
  name: string
  quote: string
  timestamp_start: number | null
  timestamp_end: number | null
  speaker: string | null
}

export interface ProofSource {
  name: string
  quote: string
  url: string | null
}

export interface Finding {
  id: string
  claim: string
  claim_source: ClaimSource
  label: Label
  decision: Decision
  /** 0 to 1, or null when Jev was not called. Shown as "Jev probability". */
  jev_probability: number | null
  explanation: string
  proof_source: ProofSource | null
  /** Decimal strings in USD, e.g. "1250000.00". Never floats. */
  claimed_usd: string | null
  proof_usd: string | null
  gap_usd: string | null
  /** Decimal string, e.g. "6.00". */
  gap_pct: string | null
  priority: Priority
  next_action: string
  mocked: boolean
}

export interface Source {
  name: string
  type: "upload" | "sec"
  date: string | null
  url: string | null
}

export interface TranscriptSegment {
  source: string
  start: number
  end: number
  speaker: string | null
  text: string
}

export interface CheckResponse {
  company: string
  period: string
  findings: Finding[]
  sources: Source[]
  transcript: { segments: TranscriptSegment[] } | null
}

export interface ApiErrorBody {
  error: string
}
