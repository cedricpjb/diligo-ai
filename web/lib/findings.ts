import { toCents } from "./money"
import type { Decision, Finding, Priority, Source } from "./types"

export const DECISION_LABEL: Record<Decision, string> = {
  YES: "YES",
  NO: "NO",
  NEEDS_REVIEW: "NEEDS REVIEW",
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 }

/** Priority first (high to low), then the larger dollar gap, then the order the API sent. */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({
      finding,
      index,
      rank: PRIORITY_RANK[finding.priority] ?? 3,
      gap: Math.abs(toCents(finding.gap_usd) ?? 0),
    }))
    .sort((a, b) => a.rank - b.rank || b.gap - a.gap || a.index - b.index)
    .map((entry) => entry.finding)
}

export interface Summary {
  yes: number
  no: number
  needsReview: number
  /** Sum of the absolute dollar gaps, in integer cents. Null when no finding has a dollar amount. */
  totalGapCents: number | null
  /** How many findings carry a dollar gap. */
  gapCount: number
  mockedCount: number
}

export function summarize(findings: Finding[]): Summary {
  let yes = 0
  let no = 0
  let needsReview = 0
  let totalGapCents = 0
  let gapCount = 0
  let mockedCount = 0

  for (const finding of findings) {
    if (finding.decision === "YES") yes++
    else if (finding.decision === "NO") no++
    else needsReview++

    const gap = toCents(finding.gap_usd)
    if (gap !== null) {
      totalGapCents += Math.abs(gap)
      gapCount++
    }
    if (finding.mocked) mockedCount++
  }

  return {
    yes,
    no,
    needsReview,
    totalGapCents: gapCount > 0 ? totalGapCents : null,
    gapCount,
    mockedCount,
  }
}

export interface SourceUsage {
  source: Source
  asClaim: number
  asProof: number
}

export function sourceUsage(sources: Source[], findings: Finding[]): SourceUsage[] {
  return sources.map((source) => ({
    source,
    asClaim: findings.filter((f) => f.claim_source.name === source.name).length,
    asProof: findings.filter((f) => f.proof_source?.name === source.name).length,
  }))
}

/** Seconds into the audio as m:ss.t, e.g. 4.2 becomes "0:04.2". */
export function formatTimestamp(seconds: number): string {
  const tenths = Math.round(seconds * 10)
  const minutes = Math.floor(tenths / 600)
  const rest = (tenths % 600) / 10
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`
}

export function formatTimeRange(start: number | null, end: number | null): string | null {
  if (start === null) return null
  return end === null || end === start
    ? formatTimestamp(start)
    : `${formatTimestamp(start)} – ${formatTimestamp(end)}`
}

/** Jev's probability as a whole percent. This is a probability, not money. */
export function formatProbability(probability: number | null): string | null {
  if (probability === null || Number.isNaN(probability)) return null
  return `${Math.round(Math.min(Math.max(probability, 0), 1) * 100)}%`
}

/** Links come from uploaded documents, so only http(s) ones are ever made clickable. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null
  } catch {
    return null
  }
}

export type ReviewState = "reviewed" | "follow-up"
