"use client"

import { useState } from "react"
import { ChevronRight, Flag, Check } from "lucide-react"

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { DecisionBadge, MockedBadge } from "./decision-badge"

interface FindingsTableProps {
  findings: Finding[]
  reviews: Record<string, ReviewState | undefined>
  onOpen: (id: string) => void
}

const NO_VALUE = "—"

type Filter = "all" | "NO" | "YES" | "NEEDS_REVIEW"

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "NO", label: "NO" },
  { id: "YES", label: "YES" },
  { id: "NEEDS_REVIEW", label: "Needs review" },
]

export function FindingsTable({ findings: all, reviews, onOpen }: FindingsTableProps) {
  const [filter, setFilter] = useState<Filter>("all")
  const showFilters = all.length >= MANY_FINDINGS
  const active = showFilters ? filter : "all"
  const findings = active === "all" ? all : all.filter((f) => f.decision === active)
  const countFor = (id: Filter) =>
    id === "all" ? all.length : all.filter((f) => f.decision === id).length

  return (
    <section aria-labelledby="findings-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="findings-title" className="text-base font-semibold tracking-tight">
          Findings
        </h2>
        <p className="text-sm text-muted-foreground">
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
                "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-semibold transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active === id
                  ? "border-foreground/40 bg-white/[0.08] text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
              <span className="text-xs tabular-nums">{countFor(id)}</span>
            </button>
          ))}
        </div>
      )}

      {/* Wide screens (with the sidebar open, 1280px and up): a table. */}
      <div className="hidden overflow-hidden rounded-2xl border border-border bg-card shadow-card xl:block">
        <Table>
          <caption className="sr-only">
            Findings sorted by decision, then priority or Jev score. Select a row to open its evidence.
          </caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-11 pl-5">Claim</TableHead>
              <TableHead className="h-11">Decision</TableHead>
              <TableHead className="h-11 text-right">Claimed</TableHead>
              <TableHead className="h-11 text-right">Proof</TableHead>
              <TableHead className="h-11 text-right">Gap</TableHead>
              <TableHead className="h-11 pr-5 text-right">Jev probability</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {findings.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="px-5 py-6 whitespace-normal text-muted-foreground">
                  No findings match this filter.
                </TableCell>
              </TableRow>
            )}
            {findings.map((finding) => {
              const gap = formatUsd(finding.gap_usd)
              const pct = formatPct(finding.gap_pct)
              const jev = formatProbability(finding.jev_probability)
              return (
                <TableRow
                  key={finding.id}
                  onClick={() => onOpen(finding.id)}
                  className="h-16 cursor-pointer has-focus-visible:bg-muted"
                >
                  <TableCell className="max-w-0 min-w-64 py-0 pl-5 whitespace-normal">
                    <button
                      type="button"
                      className="-m-2 flex w-[calc(100%+1rem)] items-start gap-2 rounded-lg p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Open evidence: ${finding.claim}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm leading-snug font-semibold text-foreground">
                          {finding.claim}
                        </span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span>{PRIORITY_LABEL[finding.priority]} priority</span>
                          <ReviewChip state={reviews[finding.id]} />
                          {finding.mocked && <MockedBadge />}
                        </span>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="py-0">
                    <DecisionBadge decision={finding.decision} />
                  </TableCell>
                  <TableCell className="py-0 text-right tabular-nums">
                    <Amount value={formatUsd(finding.claimed_usd)} />
                  </TableCell>
                  <TableCell className="py-0 text-right tabular-nums">
                    {hasNoProof(finding) ? <NoProof /> : <Amount value={formatUsd(finding.proof_usd)} />}
                  </TableCell>
                  <TableCell className="py-0 text-right tabular-nums">
                    {gap ? (
                      <>
                        <span className="block text-foreground">{gap}</span>
                        {pct && <span className="block text-xs text-muted-foreground">{pct}</span>}
                      </>
                    ) : (
                      <Amount value={null} />
                    )}
                  </TableCell>
                  <TableCell className="py-0 pr-5 text-right tabular-nums">
                    <span className="inline-flex items-center justify-end gap-2">
                      {jev ? <span className="text-foreground">{jev}</span> : <Amount value={null} />}
                      <ChevronRight
                        className="size-4 text-muted-foreground"
                        aria-hidden
                      />
                    </span>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* Phones, tablets and small laptops: the same findings as cards. */}
      <ul className="grid gap-3 md:grid-cols-2 xl:hidden">
        {findings.map((finding) => {
          const gap = formatUsd(finding.gap_usd)
          const pct = formatPct(finding.gap_pct)
          const jev = formatProbability(finding.jev_probability)
          return (
            <li key={finding.id}>
              <button
                type="button"
                onClick={() => onOpen(finding.id)}
                className="flex w-full flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-left shadow-card transition-colors duration-150 outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <DecisionBadge decision={finding.decision} />
                  {finding.mocked && <MockedBadge />}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {PRIORITY_LABEL[finding.priority]} priority
                  </span>
                </span>
                <span className="text-sm leading-snug font-semibold text-foreground">
                  {finding.claim}
                </span>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                  <Stat label="Claimed" value={formatUsd(finding.claimed_usd)} />
                  <Stat
                    label="Proof"
                    value={formatUsd(finding.proof_usd)}
                    empty={hasNoProof(finding) ? <NoProof /> : undefined}
                  />
                  <Stat label="Gap" value={gap} sub={pct} />
                  <Stat label="Jev probability" value={jev} />
                </dl>
                {reviews[finding.id] && <ReviewChip state={reviews[finding.id]} />}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Amount({ value }: { value: string | null }) {
  return value ? (
    <span className="text-foreground">{value}</span>
  ) : (
    <span className="text-muted-foreground">
      <span aria-hidden>{NO_VALUE}</span>
      <span className="sr-only">No amount</span>
    </span>
  )
}

function NoProof() {
  return <span className="text-xs text-muted-foreground">No matching proof found</span>
}

function Stat({
  label,
  value,
  sub,
  empty,
}: {
  label: string
  value: string | null
  sub?: string | null
  empty?: React.ReactNode
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 tabular-nums">
        {empty && !value ? empty : <Amount value={value} />}
        {sub && <span className="ml-2 text-xs text-muted-foreground">{sub}</span>}
      </dd>
    </div>
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
        "inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-semibold whitespace-nowrap text-foreground",
        className
      )}
    >
      <Icon className="size-3" aria-hidden />
      {state === "reviewed" ? "Reviewed" : "Needs follow-up"}
    </span>
  )
}
