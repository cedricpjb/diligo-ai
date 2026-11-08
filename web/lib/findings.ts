import { toCents } from "./money.ts"
import type { Decision, Finding, Priority, Source } from "./types.ts"

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

const DECISION_RANK: Record<Decision, number> = { NO: 0, YES: 1, NEEDS_REVIEW: 2 }

/**
 * Decision group first (NO, YES, NEEDS REVIEW, the order the filters use). Inside NO and YES:
 * priority (high to low), then the larger dollar gap. Inside NEEDS REVIEW: Jev probability,
 * highest first, with no score last, since those still wait on a human read of the wording.
 * Each comparison applies one rule to one group, so the order does not depend on input order.
 */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({
      finding,
      index,
      group: DECISION_RANK[finding.decision] ?? 3,
      priority: PRIORITY_RANK[finding.priority] ?? 3,
      gap: Math.abs(toCents(finding.gap_usd) ?? 0),
      jev: finding.jev_probability ?? -1,
    }))
    .sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group
      if (a.group === DECISION_RANK.NEEDS_REVIEW) {
        return b.jev - a.jev || a.index - b.index
      }
      return a.priority - b.priority || b.gap - a.gap || a.index - b.index
    })
    .map((entry) => entry.finding)
}

export interface LargestGap {
  finding: Finding
  /** The signed gap in integer cents, as the API sent it. */
  cents: number
}

export interface Summary {
  yes: number
  no: number
  needsReview: number
  /**
   * The single finding with the biggest dollar gap by size. Gaps of different line items
   * are never added together. Null when no finding has a dollar amount.
   */
  largestGap: LargestGap | null
  /** How many findings carry a dollar gap. */
  gapCount: number
  /** Dollar claims that have no proof amount yet, so no gap could be computed. */
  needsProofCount: number
  mockedCount: number
}

export function summarize(findings: Finding[]): Summary {
  let yes = 0
  let no = 0
  let needsReview = 0
  let largestGap: LargestGap | null = null
  let gapCount = 0
  let needsProofCount = 0
  let mockedCount = 0

  for (const finding of findings) {
    if (finding.decision === "YES") yes++
    else if (finding.decision === "NO") no++
    else needsReview++

    const gap = toCents(finding.gap_usd)
    if (gap !== null) {
      gapCount++
      // Strictly larger wins, so a tie keeps the earlier finding.
      if (largestGap === null || Math.abs(gap) > Math.abs(largestGap.cents)) {
        largestGap = { finding, cents: gap }
      }
    }
    else if (toCents(finding.claimed_usd) !== null && toCents(finding.proof_usd) === null) {
      needsProofCount++
    }
    if (finding.mocked) mockedCount++
  }

  return {
    yes,
    no,
    needsReview,
    largestGap,
    gapCount,
    needsProofCount,
    mockedCount,
  }
}

/** True when a finding has nothing to compare against: no proof quote and no proof amount. */
export function hasNoProof(finding: Finding): boolean {
  return finding.proof_source === null && finding.proof_usd === null
}

/** At this many findings the list gets filter chips and the review count leads. */
export const MANY_FINDINGS = 30

export { knownText } from "./known-text.ts"

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

/**
 * A short name for a claim, for tight places: "Revenue was $1,250,000.00." becomes "Revenue".
 * It only ever shortens the claim's own words, and falls back to the whole claim.
 */
export function claimName(claim: string): string {
  const match = /^(.{2,40}?)\s+(?:was|were|is|are)\s/i.exec(claim.trim())
  return match ? match[1] : claim.trim()
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

/** Milliseconds as m:ss, rounded outward (start down, end up) so the range covers the quote. */
export function formatClipRange(startMs: number, endMs: number): string {
  const clock = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  return `${clock(Math.floor(startMs / 1000))} to ${clock(Math.ceil(endMs / 1000))}`
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
