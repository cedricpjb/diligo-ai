import { Check, CircleHelp, X, type LucideIcon } from "lucide-react"

import { DECISION_LABEL } from "@/lib/findings"
import type { Decision } from "@/lib/types"
import { cn } from "@/lib/utils"

const STYLE: Record<Decision, { icon: LucideIcon; classes: string }> = {
  YES: { icon: Check, classes: "border-yes/50 text-yes" },
  NO: { icon: X, classes: "border-no/50 text-no" },
  NEEDS_REVIEW: { icon: CircleHelp, classes: "border-review/50 text-review" },
}

/** An outlined stamp. Status colour appears only on findings, always beside a text label and an icon. */
export function DecisionBadge({
  decision,
  size = "default",
  className,
}: {
  decision: Decision
  size?: "default" | "large"
  className?: string
}) {
  const { icon: Icon, classes } = STYLE[decision]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[3px] border font-semibold tracking-[0.12em] whitespace-nowrap",
        size === "large" ? "px-3 py-1 text-xs" : "px-2.5 py-0.5 text-[11px]",
        classes,
        className
      )}
    >
      <Icon className="size-3" strokeWidth={2.5} aria-hidden />
      {DECISION_LABEL[decision]}
    </span>
  )
}

/** A finding that came from mock results. Neutral on purpose: it is not a decision colour. */
export function MockedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[3px] border border-dashed border-foreground/35 px-2 py-0.5 text-[11px] font-semibold tracking-[0.12em] whitespace-nowrap text-muted-foreground uppercase",
        className
      )}
    >
      Mocked
    </span>
  )
}
