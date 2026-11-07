"use client"

import { useMemo, useSyncExternalStore } from "react"

import { INVESTIGATION_KEY, type StoredInvestigation } from "@/lib/investigation-store"

const subscribe = () => () => {}

export type InvestigationState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "ready"; investigation: StoredInvestigation }

/**
 * Reads the latest investigation from sessionStorage without a setState-in-effect.
 * The server render and the first client render are "loading", so nothing flashes.
 */
export function useInvestigation(): InvestigationState {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
  const raw = useSyncExternalStore(
    subscribe,
    () => sessionStorage.getItem(INVESTIGATION_KEY),
    () => null
  )

  return useMemo<InvestigationState>(() => {
    if (!hydrated) return { status: "loading" }
    if (!raw) return { status: "empty" }
    try {
      const parsed = JSON.parse(raw) as StoredInvestigation
      return Array.isArray(parsed?.response?.findings)
        ? { status: "ready", investigation: parsed }
        : { status: "empty" }
    } catch {
      return { status: "empty" }
    }
  }, [hydrated, raw])
}
