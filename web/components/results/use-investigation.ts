"use client"

import { useMemo, useSyncExternalStore } from "react"

import {
  getLatest,
  readStoredRaw,
  subscribeLatest,
  type StoredInvestigation,
} from "@/lib/investigation-store"

const subscribeNever = () => () => {}

export type InvestigationState =
  | { status: "loading" }
  | { status: "empty" }
  | {
      status: "ready"
      investigation: StoredInvestigation
      /** False when the result lives only in memory because the browser would not store it. */
      persisted: boolean
    }

/**
 * The newest investigation: the in-memory copy if this page session made one, otherwise
 * the copy in sessionStorage (after a reload). The server render and the first client
 * render are "loading", so nothing flashes.
 */
export function useInvestigation(): InvestigationState {
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  )
  const memory = useSyncExternalStore(subscribeLatest, getLatest, () => null)
  const raw = useSyncExternalStore(subscribeNever, readStoredRaw, () => null)

  return useMemo<InvestigationState>(() => {
    if (!hydrated) return { status: "loading" }
    if (memory) {
      return { status: "ready", investigation: memory.investigation, persisted: memory.persisted }
    }
    if (!raw) return { status: "empty" }
    try {
      const parsed = JSON.parse(raw) as StoredInvestigation
      return Array.isArray(parsed?.response?.findings)
        ? { status: "ready", investigation: parsed, persisted: true }
        : { status: "empty" }
    } catch {
      return { status: "empty" }
    }
  }, [hydrated, memory, raw])
}
