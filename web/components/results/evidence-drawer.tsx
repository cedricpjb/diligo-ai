"use client"

import { Check, ExternalLink, Flag, X } from "lucide-react"

import {
  formatProbability,
  formatTimeRange,
  LABEL_TEXT,
  PRIORITY_LABEL,
  safeHttpUrl,
  type ReviewState,
} from "@/lib/findings"
import { formatPct, formatUsd } from "@/lib/money"
import type { Decision, Finding } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ClipPlayer } from "./clip-player"
import { DecisionBadge, MockedBadge } from "./decision-badge"

interface EvidenceDrawerProps {
  finding: Finding | null
  open: boolean
  review: ReviewState | undefined
  onOpenChange: (open: boolean) => void
  onReview: (id: string, state: ReviewState) => void
}

const CAPTION = "text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase"

/** The colour of the thin rule above the gap figure, matching the finding's decision. */
const GAP_RULE: Record<Decision, string> = {
  YES: "shadow-[inset_0_2px_0_var(--status-yes)]",
  NO: "shadow-[inset_0_2px_0_var(--status-no)]",
  NEEDS_REVIEW: "shadow-[inset_0_2px_0_var(--status-review)]",
}

export function EvidenceDrawer({
  finding,
  open,
  review,
  onOpenChange,
  onReview,
}: EvidenceDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-[40rem] gap-0 border-border bg-card p-0"
      >
        <SheetClose
          render={
            <Button
              variant="ghost"
              aria-label="Close evidence"
              className="absolute top-2 right-2 z-10 size-11 sm:top-4 sm:right-5"
            />
          }
        >
          <X aria-hidden />
        </SheetClose>
        {finding && (
          <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto overscroll-contain px-5 pt-6 pb-10 sm:px-10 sm:pt-8">
            <SheetHeader className="gap-0 p-0 pr-10">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <DecisionBadge decision={finding.decision} size="large" />
                <span className={CAPTION}>
                  {LABEL_TEXT[finding.label]} · {PRIORITY_LABEL[finding.priority]} priority
                </span>
                {finding.mocked && <MockedBadge />}
              </div>
              <SheetTitle className="mt-4 font-serif text-[26px] leading-[1.2] font-medium tracking-tight text-balance sm:text-[30px]">
                {finding.claim}
              </SheetTitle>
              <SheetDescription className="sr-only">
                Evidence behind this finding: the claim, the proof, the gap, and the next action.
              </SheetDescription>
            </SheetHeader>

            {finding.mocked && (
              <p className="rounded-[4px] border border-dashed border-foreground/35 px-3.5 py-3 text-sm leading-relaxed text-muted-foreground">
                <span className="font-semibold text-foreground">Mocked result.</span> A service key
                was missing, so the server used placeholder results for this finding. Check it by
                hand before relying on it.
              </p>
            )}

            <Compare finding={finding} />
            <ClaimEvidence finding={finding} />
            <ProofEvidence finding={finding} />
            <JevSection probability={finding.jev_probability} />

            <section className="flex flex-col gap-2 border-t border-border pt-8">
              <h3 className={CAPTION}>Explanation</h3>
              <p className="text-[15px] leading-[1.65] text-foreground">{finding.explanation}</p>
            </section>

            <section
              aria-labelledby="next-action-title"
              className="rounded-[4px] border border-l-[3px] border-border border-l-brand bg-surface-inset p-5"
            >
              <h3 id="next-action-title" className={cn(CAPTION, "text-brand")}>
                Recommended next action
              </h3>
              <p className="mt-2 text-base leading-relaxed text-foreground">{finding.next_action}</p>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <Button
                  variant={review === "reviewed" ? "default" : "outline"}
                  aria-pressed={review === "reviewed"}
                  onClick={() => onReview(finding.id, "reviewed")}
                  className="h-11 gap-2 rounded-[4px] sm:h-10"
                >
                  <Check aria-hidden />
                  {review === "reviewed" ? "Marked as reviewed" : "Mark as reviewed"}
                </Button>
                <Button
                  variant={review === "follow-up" ? "default" : "outline"}
                  aria-pressed={review === "follow-up"}
                  onClick={() => onReview(finding.id, "follow-up")}
                  className="h-11 gap-2 rounded-[4px] sm:h-10"
                >
                  <Flag aria-hidden />
                  {review === "follow-up" ? "Needs follow-up (set)" : "Needs follow-up"}
                </Button>
              </div>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** A source block: a caption with the provenance on the right, then the quote in the source's own words. */
function Evidence({
  title,
  provenance,
  children,
}: {
  title: string
  provenance: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-2">
        <h3 className={CAPTION}>{title}</h3>
        <p className="flex flex-wrap items-baseline gap-x-2.5 text-xs text-muted-foreground">
          {provenance}
        </p>
      </div>
      {children}
    </section>
  )
}

function Quote({ children }: { children: React.ReactNode }) {
  return (
    <blockquote className="border-l-2 border-foreground/25 pl-4 font-serif text-lg leading-[1.5] text-foreground italic sm:text-[19px]">
      {children}
    </blockquote>
  )
}

function ClaimEvidence({ finding }: { finding: Finding }) {
  const { claim_source: source } = finding
  const time = formatTimeRange(source.timestamp_start, source.timestamp_end)
  return (
    <Evidence
      title="What they said"
      provenance={
        <>
          <span className="break-all text-foreground">
            <span className="sr-only">File: </span>
            {source.name}
          </span>
          {source.speaker && (
            <span>
              <span className="sr-only">Speaker: </span>
              {source.speaker}
            </span>
          )}
          {time && (
            <span className="tabular-nums">
              <span className="sr-only">Time in the audio: </span>
              {time}
            </span>
          )}
        </>
      }
    >
      <Quote>“{source.quote}”</Quote>
      <ClipPlayer key={finding.id} finding={finding} />
    </Evidence>
  )
}

function ProofEvidence({ finding }: { finding: Finding }) {
  const proof = finding.proof_source
  if (!proof) {
    return (
      <Evidence title="The proof" provenance={null}>
        <p className="rounded-[4px] border border-dashed border-foreground/25 px-4 py-3 text-sm text-muted-foreground">
          No matching proof found
        </p>
      </Evidence>
    )
  }
  const href = safeHttpUrl(proof.url)
  return (
    <Evidence
      title="The proof"
      provenance={
        <>
          <span className="break-all text-foreground">
            <span className="sr-only">File: </span>
            {proof.name}
          </span>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-sm text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Open source
              <ExternalLink className="size-3" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : (
            <span>Uploaded file, no link</span>
          )}
        </>
      }
    >
      <Quote>“{proof.quote}”</Quote>
    </Evidence>
  )
}

/** Claimed, proof and gap side by side, so the difference reads at a glance. */
function Compare({ finding }: { finding: Finding }) {
  const claimed = formatUsd(finding.claimed_usd)
  const proof = formatUsd(finding.proof_usd)
  const gap = formatUsd(finding.gap_usd)
  const pct = formatPct(finding.gap_pct)
  if (!claimed && !proof && !gap) return null

  return (
    <section aria-label="Claimed, proof and gap">
      <dl className="grid grid-cols-3 overflow-hidden rounded-[4px] border border-border bg-surface-inset [&>div:not(:last-child)]:border-r [&>div]:border-border">
        <Figure label="Claimed" value={claimed} />
        <Figure label="Proof" value={proof} />
        <Figure label="Gap" value={gap} sub={pct} className={GAP_RULE[finding.decision]} strong />
      </dl>
    </section>
  )
}

function Figure({
  label,
  value,
  sub,
  strong,
  className,
}: {
  label: string
  value: string | null
  sub?: string | null
  strong?: boolean
  className?: string
}) {
  return (
    <div className={cn("min-w-0 px-3 py-4 sm:px-5", className)}>
      <dt className={CAPTION}>{label}</dt>
      <dd
        className={cn(
          "mt-1.5 font-serif text-base leading-tight tabular-nums sm:text-[22px]",
          strong ? "font-medium" : "font-normal"
        )}
      >
        {value ?? (
          <>
            <span aria-hidden className="text-muted-foreground">
              —
            </span>
            <span className="sr-only">No amount</span>
          </>
        )}
      </dd>
      {sub && <dd className="mt-0.5 text-xs text-muted-foreground tabular-nums">{sub}</dd>}
    </div>
  )
}

function JevSection({ probability }: { probability: number | null }) {
  const value = formatProbability(probability)
  if (!value || probability === null) {
    return (
      <section aria-labelledby="jev-title">
        <h3 id="jev-title" className="sr-only">
          Jev probability
        </h3>
        <p className="text-[13px] text-muted-foreground">
          Numbers are checked exactly by code. Jev only judges wording claims.
        </p>
      </section>
    )
  }
  const percent = Math.round(Math.min(Math.max(probability, 0), 1) * 100)
  return (
    <section aria-labelledby="jev-title" className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h3 id="jev-title" className={CAPTION}>
          Jev probability
        </h3>
        <div
          role="progressbar"
          aria-labelledby="jev-title"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/12"
        >
          <div className="h-full rounded-full bg-muted-foreground" style={{ width: `${percent}%` }} />
        </div>
        <p className="text-sm font-semibold tabular-nums">{value}</p>
      </div>
      <p className="text-[13px] text-muted-foreground">
        Jev: how strongly the proof passage supports this sentence (80% or more is needed for YES).
      </p>
    </section>
  )
}
