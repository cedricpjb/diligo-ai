// Regression checks for how Jev's probability drives NEEDS REVIEW ordering, and the
// text shown when Jev was and was not called. Run with: npm test
import assert from "node:assert/strict"
import { formatProbability, sortFindings } from "../lib/findings.ts"

function finding(overrides) {
  return {
    id: overrides.id,
    claim: overrides.id,
    claim_source: { name: "x", quote: "x", timestamp_start: null, timestamp_end: null, speaker: null },
    label: "insufficient",
    decision: overrides.decision ?? "NEEDS_REVIEW",
    jev_probability: overrides.jev_probability ?? null,
    explanation: "",
    proof_source: null,
    claimed_usd: null,
    proof_usd: null,
    gap_usd: null,
    gap_pct: null,
    priority: overrides.priority ?? "medium",
    next_action: "",
    mocked: false,
    ...overrides,
  }
}

// NEEDS REVIEW findings sort by Jev probability, highest first, no-score last.
{
  const findings = [
    finding({ id: "no-score", decision: "NEEDS_REVIEW", jev_probability: null }),
    finding({ id: "low", decision: "NEEDS_REVIEW", jev_probability: 0.3 }),
    finding({ id: "high", decision: "NEEDS_REVIEW", jev_probability: 0.79 }),
    finding({ id: "mid", decision: "NEEDS_REVIEW", jev_probability: 0.55 }),
  ]
  const order = sortFindings(findings).map((f) => f.id)
  assert.deepEqual(order, ["high", "mid", "low", "no-score"])
}

// Other decisions keep the existing priority sort: high priority first, regardless of Jev.
{
  const findings = [
    finding({ id: "yes-low-priority-high-jev", decision: "YES", priority: "low", jev_probability: 0.95 }),
    finding({ id: "yes-high-priority-low-jev", decision: "YES", priority: "high", jev_probability: 0.1 }),
  ]
  const order = sortFindings(findings).map((f) => f.id)
  assert.deepEqual(order, ["yes-high-priority-low-jev", "yes-low-priority-high-jev"])
}

// formatProbability still reads as a percentage, unrelated to the text shown around it.
assert.equal(formatProbability(0.8), "80%")
assert.equal(formatProbability(null), null)

console.log("jev-sort: all checks passed")
