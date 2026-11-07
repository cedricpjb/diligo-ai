import { claimName, type Summary } from "@/lib/findings"
import { formatCents, formatPct } from "@/lib/money"
import { cn } from "@/lib/utils"

type Tone = "yes" | "no" | "review"

const DOT: Record<Tone, string> = {
  yes: "bg-yes",
  no: "bg-no",
  review: "bg-review",
}

const NUMBER: Record<Tone, string> = {
  yes: "text-yes",
  no: "text-no",
  review: "text-review",
}

const CARD =
  "flex flex-col gap-3 rounded-2xl border border-border bg-card p-3.5 shadow-card sm:p-5"

export function SummaryRow({ summary }: { summary: Summary }) {
  const counts: { label: string; value: number; note: string; tone: Tone }[] = [
    { label: "YES", value: summary.yes, note: "Backed by the proof", tone: "yes" },
    { label: "NO", value: summary.no, note: "Contradicted by the proof", tone: "no" },
    {
      label: "NEEDS REVIEW",
      value: summary.needsReview,
      note: "An analyst must decide",
      tone: "review",
    },
  ]

  return (
    <section aria-label="Summary" className="grid grid-cols-3 gap-3 xl:grid-cols-4">
      {counts.map((tile) => (
        <div key={tile.label} className={CARD}>
          <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground">
            <span aria-hidden className={cn("size-2 rounded-full", DOT[tile.tone])} />
            {tile.label}
          </p>
          <p
            className={cn(
              "text-3xl leading-none font-semibold tracking-tight tabular-nums",
              NUMBER[tile.tone]
            )}
          >
            {tile.value}
          </p>
          <p className="hidden text-xs text-muted-foreground sm:block">{tile.note}</p>
        </div>
      ))}
      <LargestGapTile summary={summary} />
    </section>
  )
}

/** One finding's gap, never a sum: adding gaps of different line items means nothing. */
function LargestGapTile({ summary }: { summary: Summary }) {
  const { largestGap, gapCount } = summary
  const pct = largestGap ? formatPct(largestGap.finding.gap_pct) : null

  return (
    <div className={cn(CARD, "col-span-3 xl:col-span-1")}>
      <p className="text-xs font-semibold tracking-wide text-muted-foreground">Largest gap</p>

      {largestGap ? (
        <>
          <p className="text-3xl leading-none font-semibold tracking-tight text-foreground tabular-nums [overflow-wrap:anywhere] xl:text-2xl 2xl:text-3xl">
            {formatCents(largestGap.cents)}
          </p>
          <p className="text-xs text-muted-foreground">
            {largestGap.cents === 0 ? (
              gapCount === 1
                ? "The dollar claim matches the proof"
                : `All ${gapCount} dollar claims match the proof`
            ) : (
              <>
                {pct && <span className="tabular-nums">{pct}</span>}
                {pct && <span aria-hidden> · </span>}
                <span className="text-foreground" title={largestGap.finding.claim}>
                  {claimName(largestGap.finding.claim)}
                </span>
              </>
            )}
          </p>
        </>
      ) : (
        <>
          <p className="text-3xl leading-none font-semibold tracking-tight text-muted-foreground">
            <span aria-hidden>—</span>
            <span className="sr-only">No dollar gap</span>
          </p>
          <p className="text-xs text-muted-foreground">No dollar claims found</p>
        </>
      )}
    </div>
  )
}
