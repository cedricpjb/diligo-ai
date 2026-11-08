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

// Mixed decisions and priorities: the order must not depend on input order.
// (A is NEEDS_REVIEW/low/0.79, B is YES/medium, C is NEEDS_REVIEW/high/0.30. A pairwise
// rule that switched between Jev and priority made these three form a cycle.)
{
  const a = finding({ id: "A", decision: "NEEDS_REVIEW", priority: "low", jev_probability: 0.79 })
  const b = finding({ id: "B", decision: "YES", priority: "medium" })
  const c = finding({ id: "C", decision: "NEEDS_REVIEW", priority: "high", jev_probability: 0.3 })
  const expected = ["B", "A", "C"]
  const items = [a, b, c]

  function permutations(list) {
    if (list.length <= 1) return [list]
    return list.flatMap((item, i) =>
      permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest])
    )
  }
  for (const perm of permutations(items)) {
    assert.deepEqual(sortFindings(perm).map((f) => f.id), expected)
  }
}

// Decision groups keep the filter order (NO, YES, NEEDS REVIEW), and the starter-shaped
// results keep the same order they had before (NO by priority and gap, then YES).
{
  const findings = [
    finding({ id: "debt", decision: "YES", priority: "low" }),
    finding({ id: "revenue", decision: "NO", priority: "high", gap_usd: "75000.00" }),
    finding({ id: "cash", decision: "NO", priority: "high", gap_usd: "70000.00" }),
    finding({ id: "contracts", decision: "NO", priority: "high", gap_usd: null }),
  ]
  assert.deepEqual(sortFindings(findings).map((f) => f.id), ["revenue", "cash", "contracts", "debt"])
}

// formatProbability still reads as a percentage, unrelated to the text shown around it.
assert.equal(formatProbability(0.8), "80%")
assert.equal(formatProbability(null), null)

console.log("jev-sort: all checks passed")
