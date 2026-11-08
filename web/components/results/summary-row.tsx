import { claimName, type Summary } from "@/lib/findings"
import { formatCents, formatPct } from "@/lib/money"
import { cn } from "@/lib/utils"

type Tone = "yes" | "no" | "review"

const DOT: Record<Tone, string> = { yes: "bg-yes", no: "bg-no", review: "bg-review" }

const CELL = "flex min-w-0 flex-col gap-2 border-border p-4 max-sm:odd:pl-0 sm:px-6 sm:py-5 sm:first:pl-0"
const LABEL = "flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase"
const COUNT = "font-serif text-5xl leading-none font-medium tabular-nums"

/** One typographic band: the three decision counts, then the single largest gap. */
export function SummaryRow({ summary, reviewFirst }: { summary: Summary; reviewFirst?: boolean }) {
  const counts: { label: string; value: number; tone: Tone }[] = [
    { label: "YES", value: summary.yes, tone: "yes" },
    { label: "NO", value: summary.no, tone: "no" },
    { label: "NEEDS REVIEW", value: summary.needsReview, tone: "review" },
  ]
  if (reviewFirst) counts.unshift(...counts.splice(2, 1))

  return (
    <section
      aria-label="Summary"
      className="grid grid-cols-2 border-y border-border sm:grid-cols-4 [&>*:nth-child(odd)]:border-r [&>*:nth-child(-n+2)]:border-b sm:[&>*]:border-r sm:[&>*:nth-child(-n+2)]:border-b-0 sm:[&>*:last-child]:border-r-0 sm:[&>*:first-child]:pl-0"
    >
      {counts.map((tile) => (
        <div key={tile.label} className={CELL}>
          <p className={LABEL}>
            <span aria-hidden className={cn("size-[7px] rounded-full", DOT[tile.tone])} />
            {tile.label}
          </p>
          <p className={COUNT}>{tile.value}</p>
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
    <div className={CELL}>
      <p className={LABEL}>Largest gap</p>

      {largestGap ? (
        <>
          <p className="font-serif text-2xl leading-none font-medium whitespace-nowrap tabular-nums sm:text-3xl">
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
                <span title={largestGap.finding.claim}>{claimName(largestGap.finding.claim)}</span>
              </>
            )}
          </p>
        </>
      ) : (
        <>
          <p className="font-serif text-3xl leading-none font-medium text-muted-foreground">
            <span aria-hidden>—</span>
            <span className="sr-only">No dollar gap</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {needsProofCount > 0 ? (
              <>
                No gaps computed yet · <span className="tabular-nums">{needsProofCount}</span>{" "}
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
