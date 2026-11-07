// Keeps the latest investigation so the Results screen can read it after the New
// Investigation screen navigates away. No database.
//
// The result is held in memory, which survives moving between screens, and is also
// copied to sessionStorage so a reload keeps it. If sessionStorage refuses the write
// (storage full or blocked), the memory copy still serves Results, and the old stored
// investigation is removed, so a reload shows "No results yet" and never a stale one.

import type { CheckResponse } from "./types"

export interface StoredInvestigation {
  dealName: string
  ticker: string | null
  createdAt: string
  sample: boolean
  response: CheckResponse
}

export const INVESTIGATION_KEY = "diligo:last-investigation"

export interface LatestInvestigation {
  investigation: StoredInvestigation
  /** False when the browser would not store it: a reload will lose this result. */
  persisted: boolean
}

let latest: LatestInvestigation | null = null
const listeners = new Set<() => void>()

export function subscribeLatest(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A stable reference, so it is safe as a useSyncExternalStore snapshot. */
export function getLatest(): LatestInvestigation | null {
  return latest
}

/** The raw stored copy, or null if there is none or storage cannot be read. */
export function readStoredRaw(): string | null {
  try {
    return sessionStorage.getItem(INVESTIGATION_KEY)
  } catch {
    return null
  }
}

export function saveInvestigation(investigation: StoredInvestigation): LatestInvestigation {
  let persisted = false
  try {
    sessionStorage.setItem(INVESTIGATION_KEY, JSON.stringify(investigation))
    persisted = true
  } catch {
    try {
      sessionStorage.removeItem(INVESTIGATION_KEY)
    } catch {
      // Storage is blocked entirely; there is nothing stale to remove.
    }
  }

  latest = { investigation, persisted }
  listeners.forEach((listener) => listener())
  return latest
}
