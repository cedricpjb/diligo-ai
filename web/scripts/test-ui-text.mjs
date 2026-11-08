// Checks the navigation items and the Findings sort note. Run with: npm test
import assert from "node:assert/strict"
import { NAV_ITEMS } from "../components/shell/nav.ts"
import { FINDINGS_SORT_NOTE } from "../lib/findings.ts"

assert.deepEqual(
  NAV_ITEMS.map((item) => item.title),
  ["New Investigation", "Results"]
)
assert.deepEqual(
  NAV_ITEMS.map((item) => item.href),
  ["/new", "/results"]
)
assert.equal(FINDINGS_SORT_NOTE, "Sorted by decision, then priority or Jev score.")
console.log("ui text: all checks passed")
