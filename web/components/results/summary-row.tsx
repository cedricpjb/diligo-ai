import { claimName, type Summary } from "@/lib/findings"
import { formatCents, formatPct } from "@/lib/money"
import { cn } from "@/lib/utils"

type Tone = "yes" | "no" | "review"

const NUMBER: Record<Tone, string> = {
  yes: "text-yes",
  no: "text-no",
  review: "text-review",
}

const TILE = "flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-card sm:p-5"
const LABEL = "text-xs font-semibold tracking-wide text-muted-foreground uppercase"
const METRIC = "text-2xl leading-none font-semibold tracking-tight tabular-nums"

export function SummaryRow({ summary, reviewFirst }: { summary: Summary; reviewFirst?: boolean }) {
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

  if (reviewFirst) counts.unshift(...counts.splice(2, 1))

  return (
    <section aria-label="Summary" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {counts.map((tile) => (
        <div key={tile.label} className={TILE}>
          <p className={LABEL}>{tile.label}</p>
          <p className={cn(METRIC, NUMBER[tile.tone])}>{tile.value}</p>
          <p className="text-xs text-muted-foreground">{tile.note}</p>
        </div>
      ))}
      <LargestGapTile summary={summary} />
    </section>
  )
}

/** One finding's gap, never a sum: adding gaps of different line items means nothing. */
function LargestGapTile({ summary }: { summary: Summary }) {
  const { largestGap, gapCount, needsProofCount } = summary
  const pct = largestGap ? formatPct(largestGap.finding.gap_pct) : null

  return (
    <div className={TILE}>
      <p className={LABEL}>Largest gap</p>

      {largestGap ? (
        <>
          <p className={cn(METRIC, "text-foreground [overflow-wrap:anywhere]")}>
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
          <p className={cn(METRIC, "text-muted-foreground")}>
            <span aria-hidden>—</span>
            <span className="sr-only">No dollar gap</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {needsProofCount > 0 ? (
              <>
                <span className="text-foreground">No gaps computed yet</span>
                <span aria-hidden> · </span>
                <span className="tabular-nums">{needsProofCount}</span>{" "}
                {needsProofCount === 1 ? "claim needs" : "claims need"} proof
              </>
            ) : (
              "No dollar claims found"
            )}
          </p>
        </>
      )}
    </div>
  )
}
