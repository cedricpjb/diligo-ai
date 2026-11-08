"use client"

import { useState } from "react"
import { Check, Flag } from "lucide-react"

import {
  FINDINGS_SORT_NOTE,
  formatProbability,
  hasNoProof,
  MANY_FINDINGS,
  PRIORITY_LABEL,
  type ReviewState,
} from "@/lib/findings"
import { formatPct, formatUsd } from "@/lib/money"
import type { Finding } from "@/lib/types"
import { cn } from "@/lib/utils"
import { DecisionBadge, MockedBadge } from "./decision-badge"

interface FindingsTableProps {
  findings: Finding[]
  reviews: Record<string, ReviewState | undefined>
  /** The finding whose evidence is open, so its row can stand out. */
  activeId?: string | null
  onOpen: (id: string) => void
}

type Filter = "all" | "NO" | "YES" | "NEEDS_REVIEW"

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "NO", label: "NO" },
  { id: "YES", label: "YES" },
  { id: "NEEDS_REVIEW", label: "Needs review" },
]

const CAPTION = "text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase"

export function FindingsTable({ findings: all, reviews, activeId, onOpen }: FindingsTableProps) {
  const [filter, setFilter] = useState<Filter>("all")
  const showFilters = all.length >= MANY_FINDINGS
  const active = showFilters ? filter : "all"
  const findings = active === "all" ? all : all.filter((f) => f.decision === active)
  const countFor = (id: Filter) =>
    id === "all" ? all.length : all.filter((f) => f.decision === id).length

  return (
    <section aria-labelledby="findings-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="findings-title" className="font-serif text-2xl font-medium tracking-tight">
          Findings
        </h2>
        <p className="text-xs text-muted-foreground">
          {FINDINGS_SORT_NOTE} Select a finding to see the evidence.
        </p>
      </div>

      {showFilters && (
        <div role="group" aria-label="Filter findings" className="flex flex-wrap gap-2">
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={active === id}
              onClick={() => setFilter(id)}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-[3px] border px-3.5 text-sm font-semibold transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active === id
                  ? "border-foreground/40 bg-card text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
              <span className="text-xs tabular-nums">{countFor(id)}</span>
            </button>
          ))}
        </div>
      )}

      {findings.length === 0 ? (
        <p className="border-t border-border py-6 text-sm text-muted-foreground">
          No findings match this filter.
        </p>
      ) : (
        <ul className="border-b border-border">
          {findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              review={reviews[finding.id]}
              active={finding.id === activeId}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function FindingRow({
  finding,
  review,
  active,
  onOpen,
}: {
  finding: Finding
  review: ReviewState | undefined
  active: boolean
  onOpen: (id: string) => void
}) {
  const gap = formatUsd(finding.gap_usd)
  const jev = formatProbability(finding.jev_probability)

  return (
    <li className="border-t border-border">
      <button
        type="button"
        aria-label={`Open evidence: ${finding.claim}`}
        onClick={() => onOpen(finding.id)}
        className={cn(
          "-mx-4 grid w-[calc(100%+2rem)] gap-x-6 gap-y-4 px-4 py-5 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:-mx-5 sm:w-[calc(100%+2.5rem)] sm:px-5 lg:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,26rem)] lg:py-6",
          active ? "bg-card shadow-[inset_2px_0_0_var(--brand)]" : "hover:bg-card/60"
        )}
      >
        <span className="flex flex-wrap items-start gap-2 lg:flex-col lg:pt-1">
          <DecisionBadge decision={finding.decision} />
          {finding.mocked && <MockedBadge />}
        </span>

        <span className="min-w-0">
          <span className="block font-serif text-xl leading-snug font-medium text-pretty lg:text-[22px]">
            {finding.claim}
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted-foreground">
            <span>{PRIORITY_LABEL[finding.priority]} priority</span>
            <span aria-hidden>·</span>
            <span className="break-all">{finding.claim_source.name}</span>
            {jev && (
              <>
                <span aria-hidden>·</span>
                <span>Jev probability {jev}</span>
              </>
            )}
            {review && <ReviewChip state={review} />}
          </span>
        </span>

        <span className="grid grid-cols-3 gap-3 tabular-nums">
          <Figure label="Claimed" value={formatUsd(finding.claimed_usd)} />
          <Figure
            label="Proof"
            value={formatUsd(finding.proof_usd)}
            empty={hasNoProof(finding) ? "No matching proof" : undefined}
          />
          <Figure label="Gap" value={gap} sub={formatPct(finding.gap_pct)} strong />
        </span>
      </button>
    </li>
  )
}

function Figure({
  label,
  value,
  sub,
  strong,
  empty,
}: {
  label: string
  value: string | null
  sub?: string | null
  strong?: boolean
  empty?: string
}) {
  return (
    <span className="block min-w-0">
      <span className={cn(CAPTION, "block")}>{label}</span>
      <span className={cn("mt-1 block text-[15px]", strong && "font-semibold")}>
        {value ?? (
          empty ? (
            <span className="text-xs font-normal text-muted-foreground">{empty}</span>
          ) : (
            <span className="text-muted-foreground">
              <span aria-hidden>—</span>
              <span className="sr-only">No amount</span>
            </span>
          )
        )}
      </span>
      {sub && <span className="block text-xs font-normal text-muted-foreground">{sub}</span>}
    </span>
  )
}

export function ReviewChip({
  state,
  className,
}: {
  state: ReviewState | undefined
  className?: string
}) {
  if (!state) return null
  const Icon = state === "reviewed" ? Check : Flag
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[3px] border border-border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-foreground",
        className
      )}
    >
      <Icon className="size-3" aria-hidden />
      {state === "reviewed" ? "Reviewed" : "Needs follow-up"}
    </span>
  )
}
