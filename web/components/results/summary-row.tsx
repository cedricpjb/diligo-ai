import { formatCents } from "@/lib/money"
import type { Summary } from "@/lib/findings"
import { cn } from "@/lib/utils"

interface Tile {
  label: string
  value: string
  note: string
  /** Status colour for the dot and number. Only the three decisions use one. */
  tone?: "yes" | "no" | "review"
}

const DOT: Record<NonNullable<Tile["tone"]>, string> = {
  yes: "bg-yes",
  no: "bg-no",
  review: "bg-review",
}

const NUMBER: Record<NonNullable<Tile["tone"]>, string> = {
  yes: "text-yes",
  no: "text-no",
  review: "text-review",
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

export function SummaryRow({ summary }: { summary: Summary }) {
  const tiles: Tile[] = [
    {
      label: "YES",
      value: String(summary.yes),
      note: "Backed by the proof",
      tone: "yes",
    },
    {
      label: "NO",
      value: String(summary.no),
      note: "Contradicted by the proof",
      tone: "no",
    },
    {
      label: "NEEDS REVIEW",
      value: String(summary.needsReview),
      note: "An analyst must decide",
      tone: "review",
    },
    {
      label: "Total gap",
      value: summary.totalGapCents === null ? "—" : formatCents(summary.totalGapCents),
      note:
        summary.gapCount === 0
          ? "No dollar claims found"
          : `Across ${plural(summary.gapCount, "dollar claim", "dollar claims")}`,
    },
  ]

  return (
    <section aria-label="Summary" className="grid grid-cols-3 gap-3 xl:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className={cn(
            "flex flex-col gap-3 rounded-2xl border border-border bg-card p-3.5 shadow-card sm:p-5",
            tile.label === "Total gap" && "col-span-3 xl:col-span-1"
          )}
        >
          <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground">
            {tile.tone && (
              <span aria-hidden className={cn("size-2 rounded-full", DOT[tile.tone])} />
            )}
            {tile.label}
          </p>
          <p
            className={cn(
              "text-3xl leading-none font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]",
              tile.tone ? NUMBER[tile.tone] : "text-foreground xl:text-2xl 2xl:text-3xl"
            )}
          >
            {tile.value}
          </p>
          <p className={cn("text-xs text-muted-foreground", tile.tone && "hidden sm:block")}>
            {tile.note}
          </p>
        </div>
      ))}
    </section>
  )
}
