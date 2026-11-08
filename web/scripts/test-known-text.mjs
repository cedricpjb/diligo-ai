// Regression checks for knownText. Run with: npm test (Node 22.18+ runs .ts directly).
import assert from "node:assert/strict"
import { knownText } from "../lib/known-text.ts"

assert.equal(knownText("Unknown company"), null)
assert.equal(knownText("Unknown period"), null)
assert.equal(knownText("  unknown company  "), null)
assert.equal(knownText("Starter Co"), "Starter Co")
assert.equal(knownText("FY2025"), "FY2025")
assert.equal(knownText("Unknownable Inc"), "Unknownable Inc")
assert.equal(knownText(""), null)
assert.equal(knownText(null), null)
console.log("known-text: all checks passed")
