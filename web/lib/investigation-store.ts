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

export const INVESTIGATION_KEY = "diligo:last-investigation"

export function saveInvestigation(investigation: StoredInvestigation): void {
  try {
    sessionStorage.setItem(INVESTIGATION_KEY, JSON.stringify(investigation))
  } catch {
    // Storage can be full or blocked; the Results screen then shows its empty state.
  }
}
