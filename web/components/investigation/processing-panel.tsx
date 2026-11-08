"use client"

import { Check, Loader2, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

export type StepState = "pending" | "active" | "done" | "skipped"

export interface ProcessingStep {
  id: string
  label: string
  detail: string
  state: StepState
}

interface ProcessingPanelProps {
  dealName: string
  steps: ProcessingStep[]
  onCancel: () => void
}

export function ProcessingPanel({ dealName, steps, onCancel }: ProcessingPanelProps) {
  const current = steps.find((step) => step.state === "active")
  const counted = steps.filter((step) => step.state !== "skipped")
  const done = counted.filter((step) => step.state === "done").length
  const progress = counted.length === 0 ? 0 : (done + (current ? 0.5 : 0)) / counted.length

  return (
    <section
      aria-labelledby="processing-title"
      className="rounded-2xl border border-border bg-card p-5 shadow-card sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="processing-title" className="text-base font-semibold tracking-tight">
            Checking {dealName}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground" aria-live="polite">
            {current ? `${current.label}…` : "Finishing up…"}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="h-10 rounded-lg border border-border px-4 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Cancel the check
        </button>
      </div>

      <div
        className="mt-5 h-1 overflow-hidden rounded-full bg-white/[0.06]"
        role="progressbar"
        aria-label="Analysis progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <div
          className="h-full origin-left rounded-full bg-brand transition-transform duration-700 ease-out"
          style={{ transform: `scaleX(${Math.max(progress, 0.04)})` }}
        />
      </div>

      <ol className="mt-5 grid gap-2 sm:grid-cols-3">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className={cn(
              "flex items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors duration-200",
              step.state === "active"
                ? "border-brand/40 bg-brand/[0.05]"
                : "border-border bg-transparent"
            )}
          >
            <StepIcon state={step.state} />
            <div className="min-w-0">
              <p
                className={cn(
                  "text-sm font-semibold",
                  step.state === "pending" || step.state === "skipped"
                    ? "text-muted-foreground"
                    : "text-foreground"
                )}
              >
                <span className="sr-only">Step {index + 1}: </span>
                {step.label}
              </p>
              <p className="text-xs text-muted-foreground">
                {step.state === "skipped" ? "Skipped" : step.detail}
                <span className="sr-only">
                  {step.state === "done" && ", done"}
                  {step.state === "active" && ", in progress"}
                  {step.state === "pending" && ", waiting"}
                </span>
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function StepIcon({ state }: { state: StepState }) {
  const base = "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full"
  if (state === "done") {
    return (
      <span aria-hidden className={cn(base, "bg-foreground text-background")}>
        <Check className="size-3" strokeWidth={3} />
      </span>
    )
  }
  if (state === "active") {
    return (
      <span aria-hidden className={cn(base, "text-brand")}>
        <Loader2 className="size-4 animate-spin" />
      </span>
    )
  }
  if (state === "skipped") {
    return (
      <span aria-hidden className={cn(base, "border border-border text-muted-foreground")}>
        <Minus className="size-3" />
      </span>
    )
  }
  return <span aria-hidden className={cn(base, "border border-white/20")} />
}
