import { CircleCheck, CircleHelp, CircleX, type LucideIcon } from "lucide-react"

import { DECISION_LABEL } from "@/lib/findings"
import type { Decision } from "@/lib/types"
import { cn } from "@/lib/utils"

const STYLE: Record<Decision, { icon: LucideIcon; classes: string }> = {
  YES: { icon: CircleCheck, classes: "border-yes/30 bg-yes/10 text-yes" },
  NO: { icon: CircleX, classes: "border-no/30 bg-no/10 text-no" },
  NEEDS_REVIEW: { icon: CircleHelp, classes: "border-review/30 bg-review/10 text-review" },
}

/** Status colours appear only on findings, and always next to a text label and an icon. */
export function DecisionBadge({
  decision,
  className,
}: {
  decision: Decision
  className?: string
}) {
  const { icon: Icon, classes } = STYLE[decision]
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold tracking-wide whitespace-nowrap",
        classes,
        className
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {DECISION_LABEL[decision]}
    </span>
  )
}

/** A finding that came from mock results. Neutral on purpose: it is not a decision colour. */
export function MockedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full border border-dashed border-white/25 px-2.5 text-xs font-medium tracking-wide whitespace-nowrap text-muted-foreground",
        className
      )}
    >
      Mocked
    </span>
  )
}
