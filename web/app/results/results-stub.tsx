"use client"

import { useSyncExternalStore } from "react"
import Link from "next/link"

import { loadInvestigation } from "@/lib/investigation-store"

const subscribe = () => () => {}

export function ResultsStub() {
  const raw = useSyncExternalStore(
    subscribe,
    () => sessionStorage.getItem("diligo:last-investigation"),
    () => null
  )
  const investigation = raw ? loadInvestigation() : null

  if (!investigation) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 shadow-card">
        <h1 className="text-xl font-semibold tracking-tight">No results yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Run an investigation and its findings will show here.
        </p>
        <Link
          href="/new"
          className="mt-5 inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
        >
          Start an investigation
        </Link>
      </div>
    )
  }

  const { response } = investigation
  return (
    <div className="rounded-2xl border border-border bg-card p-8 shadow-card">
      <p className="text-sm text-muted-foreground">
        {response.company} · {response.period}
      </p>
      <h1 className="mt-1 text-xl font-semibold tracking-tight">{investigation.dealName}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {response.findings.length} findings are ready. The full Results screen is built in
        Stage 2.
      </p>
    </div>
  )
}
