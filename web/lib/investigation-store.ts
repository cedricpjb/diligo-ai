// Keeps the latest investigation in sessionStorage so the Results screen can
// read it after the New Investigation screen navigates away. No database.

import type { CheckResponse } from "./types"

export interface StoredInvestigation {
  dealName: string
  ticker: string | null
  createdAt: string
  sample: boolean
  response: CheckResponse
}

const KEY = "diligo:last-investigation"

export function saveInvestigation(investigation: StoredInvestigation): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(investigation))
  } catch {
    // Storage can be full or blocked; the Results screen then shows its empty state.
  }
}

export function loadInvestigation(): StoredInvestigation | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as StoredInvestigation) : null
  } catch {
    return null
  }
}
