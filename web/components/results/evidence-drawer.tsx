"use client"

import { Check, ExternalLink, Flag, FlaskConical, X } from "lucide-react"

import {
  formatProbability,
  formatTimeRange,
  PRIORITY_LABEL,
  safeHttpUrl,
  type ReviewState,
} from "@/lib/findings"
import { formatPct, formatUsd } from "@/lib/money"
import type { Finding } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
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
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl gap-0 border-border bg-card p-0"
      >
        <SheetClose
          render={
            <Button
              variant="ghost"
              aria-label="Close evidence"
              className="absolute top-2 right-2 size-11 sm:top-3 sm:right-3 sm:size-9"
            />
          }
        >
          <X aria-hidden />
        </SheetClose>
        {finding && (
          <>
            <SheetHeader className="gap-3 border-b border-border p-5 pr-14">
              <div className="flex flex-wrap items-center gap-2">
                <DecisionBadge decision={finding.decision} />
                {finding.mocked && <MockedBadge />}
                <span className="text-xs text-muted-foreground">
                  {PRIORITY_LABEL[finding.priority]} priority
                </span>
              </div>
              <SheetTitle className="text-lg leading-snug font-semibold tracking-tight text-balance">
                {finding.claim}
              </SheetTitle>
              <SheetDescription className="sr-only">
                Evidence behind this finding: the claim, the proof, the gap, and the next action.
              </SheetDescription>
            </SheetHeader>

            <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain p-5">
              {finding.mocked && (
                <div className="flex items-start gap-3 rounded-xl border border-dashed border-white/20 bg-white/[0.02] px-3.5 py-3 text-sm">
                  <FlaskConical className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">Mocked result.</span> A service
                    key was missing, so the server used placeholder results for this finding. Check
                    it by hand before relying on it.
                  </p>
                </div>
              )}

              <ClaimSection finding={finding} />
              <ProofSection finding={finding} />
              <NumbersSection finding={finding} />
              <JevSection probability={finding.jev_probability} />

              <Section title="Explanation">
                <p className="text-sm leading-relaxed text-foreground">{finding.explanation}</p>
              </Section>

              <Section title="Recommended next action">
                <p className="rounded-xl border border-border bg-surface-raised/60 px-4 py-3 text-sm leading-relaxed text-foreground">
                  {finding.next_action}
                </p>
              </Section>
            </div>

            <SheetFooter className="mt-0 flex-col gap-2 border-t border-border bg-card p-4 sm:flex-row sm:p-5">
              <Button
                variant={review === "reviewed" ? "default" : "outline"}
                aria-pressed={review === "reviewed"}
                onClick={() => onReview(finding.id, "reviewed")}
                className="h-11 w-full gap-2 sm:h-10 sm:flex-1"
              >
                <Check aria-hidden />
                {review === "reviewed" ? "Marked as reviewed" : "Mark as reviewed"}
              </Button>
              <Button
                variant={review === "follow-up" ? "default" : "outline"}
                aria-pressed={review === "follow-up"}
                onClick={() => onReview(finding.id, "follow-up")}
                className="h-11 w-full gap-2 sm:h-10 sm:flex-1"
              >
                <Flag aria-hidden />
                {review === "follow-up" ? "Needs follow-up (set)" : "Needs follow-up"}
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Section({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex flex-col gap-2.5", className)}>
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Quote({ children }: { children: React.ReactNode }) {
  return (
    <blockquote className="border-l-2 border-white/20 py-0.5 pl-4 text-[15px] leading-relaxed text-foreground">
      {children}
    </blockquote>
  )
}

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {children}
    </p>
  )
}

function ClaimSection({ finding }: { finding: Finding }) {
  const { claim_source: source } = finding
  const time = formatTimeRange(source.timestamp_start, source.timestamp_end)
  return (
    <Section title="What they said">
      <Quote>“{source.quote}”</Quote>
      <Meta>
        <span className="break-all text-foreground">{source.name}</span>
        {source.speaker && <span>Speaker: {source.speaker}</span>}
        {time && (
          <span className="tabular-nums">
            <span className="sr-only">Time in the audio: </span>
            {time}
          </span>
        )}
      </Meta>
      <ClipPlayer key={finding.id} finding={finding} />
    </Section>
  )
}

function ProofSection({ finding }: { finding: Finding }) {
  const proof = finding.proof_source
  if (!proof) {
    return (
      <Section title="The proof">
        <p className="rounded-xl border border-dashed border-white/20 px-4 py-3 text-sm text-muted-foreground">
          No matching proof found
        </p>
      </Section>
    )
  }
  const href = safeHttpUrl(proof.url)
  return (
    <Section title="The proof">
      <Quote>“{proof.quote}”</Quote>
      <Meta>
        <span className="break-all text-foreground">{proof.name}</span>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-sm text-foreground underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Open source
            <ExternalLink className="size-3" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          <span>Uploaded file, no link</span>
        )}
      </Meta>
    </Section>
  )
}

function NumbersSection({ finding }: { finding: Finding }) {
  const claimed = formatUsd(finding.claimed_usd)
  const proof = formatUsd(finding.proof_usd)
  const gap = formatUsd(finding.gap_usd)
  const pct = formatPct(finding.gap_pct)
  if (!claimed && !proof && !gap) return null

  return (
    <Section title="The numbers">
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border">
        <Figure label="Claimed" value={claimed} />
        <Figure label="Proof" value={proof} />
        <Figure label="Gap" value={gap} sub={pct} emphasis />
      </dl>
    </Section>
  )
}

function Figure({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string
  value: string | null
  sub?: string | null
  emphasis?: boolean
}) {
  return (
    <div className="bg-card px-3.5 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-[15px] tabular-nums",
          emphasis ? "font-semibold text-foreground" : "text-foreground"
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
      {sub && <dd className="text-xs text-muted-foreground tabular-nums">{sub}</dd>}
    </div>
  )
}

function JevSection({ probability }: { probability: number | null }) {
  const value = formatProbability(probability)
  return (
    <Section title="Jev probability">
      {value ? (
        <div className="flex items-start gap-4 rounded-xl border border-border bg-surface-raised/60 px-4 py-3">
          <p className="text-2xl leading-none font-semibold tracking-tight tabular-nums">{value}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Jev’s estimate that the proof supports the claim. It is a confidence signal, not an
            accuracy score, and it never overrides a check made in code.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Jev was not called for this finding.</p>
      )}
    </Section>
  )
}
