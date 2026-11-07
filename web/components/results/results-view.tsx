"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { AlertCircle, Download, Info, Loader2, X } from "lucide-react"

import { exportFindingsToExcel } from "@/lib/export"
import { sortFindings, sourceUsage, summarize, type ReviewState } from "@/lib/findings"
import type { StoredInvestigation } from "@/lib/investigation-store"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EvidenceDrawer } from "./evidence-drawer"
import { FindingsTable } from "./findings-table"
import { SourcesPanel } from "./sources-panel"
import { SummaryRow } from "./summary-row"
import { useInvestigation } from "./use-investigation"

export function ResultsView() {
  const state = useInvestigation()

  if (state.status === "loading") return <ResultsSkeleton />
  if (state.status === "empty") return <EmptyResults />
  return <Results investigation={state.investigation} persisted={state.persisted} />
}

function Results({
  investigation,
  persisted,
}: {
  investigation: StoredInvestigation
  persisted: boolean
}) {
  const { response } = investigation
  const findings = useMemo(() => sortFindings(response.findings), [response.findings])
  const summary = useMemo(() => summarize(response.findings), [response.findings])
  const usage = useMemo(
    () => sourceUsage(response.sources ?? [], response.findings),
    [response.sources, response.findings]
  )

  // Review marks are local to this screen: no storage, no server.
  const [reviews, setReviews] = useState<Record<string, ReviewState | undefined>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" })

  const selected = findings.find((finding) => finding.id === selectedId) ?? null

  function openFinding(id: string) {
    setSelectedId(id)
    setDrawerOpen(true)
  }

  async function exportToExcel() {
    if (exportState.status === "working") return
    setExportState({ status: "working" })
    try {
      const fileName = await exportFindingsToExcel(findings, investigation.dealName)
      setExportState({ status: "done", fileName })
    } catch {
      setExportState({ status: "failed" })
    }
  }

  function mark(id: string, next: ReviewState) {
    setReviews((prev) => ({ ...prev, [id]: prev[id] === next ? undefined : next }))
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 pt-8 pb-16 sm:px-8 sm:pt-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            {response.company} · {response.period}
            {investigation.ticker && (
              <span className="ml-2 rounded-md border border-border px-1.5 py-0.5 font-mono text-xs text-foreground">
                {investigation.ticker}
              </span>
            )}
          </p>
          <h1 className="mt-1.5 text-[28px] leading-[1.15] font-semibold tracking-tight text-balance sm:text-4xl">
            {investigation.dealName}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {response.findings.length} {response.findings.length === 1 ? "claim" : "claims"} checked
            against {response.sources?.length ?? 0}{" "}
            {(response.sources?.length ?? 0) === 1 ? "source" : "sources"}.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={exportToExcel}
          disabled={exportState.status === "working"}
          className="h-11 shrink-0 gap-2 self-start px-4 sm:h-10"
        >
          {exportState.status === "working" ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Download aria-hidden />
          )}
          {exportState.status === "working" ? "Preparing the file…" : "Export to Excel"}
        </Button>
      </header>

      {(investigation.sample || !persisted || summary.mockedCount > 0 || exportState.status !== "idle") && (
        <div className="flex flex-col gap-3" aria-label="Notices">
          {investigation.sample && (
            <Notice>
              <strong className="font-medium text-foreground">Sample data.</strong> No API URL is
              set, so these are the starter case’s findings, not an analysis of the files you added.
            </Notice>
          )}
          {!persisted && (
            <Notice>
              <strong className="font-medium text-foreground">This result is not saved.</strong> The
              browser would not store it, so it stays only until you reload or close this tab. Export
              it to Excel if you need to keep it.
            </Notice>
          )}
          {summary.mockedCount > 0 && (
            <Notice>
              <strong className="font-medium text-foreground">
                {summary.mockedCount} {summary.mockedCount === 1 ? "finding uses" : "findings use"}{" "}
                mock results
              </strong>{" "}
              and {summary.mockedCount === 1 ? "is" : "are"} marked Mocked. Treat{" "}
              {summary.mockedCount === 1 ? "it" : "them"} as placeholders.
            </Notice>
          )}
          {exportState.status === "done" && (
            <Notice role="status" onDismiss={() => setExportState({ status: "idle" })}>
              <strong className="font-medium text-foreground">Excel file ready.</strong> Your
              browser is saving{" "}
              <span className="font-mono text-xs break-all text-foreground">
                {exportState.fileName}
              </span>
              , with one row for each of the {response.findings.length}{" "}
              {response.findings.length === 1 ? "finding" : "findings"}.
            </Notice>
          )}
          {exportState.status === "failed" && (
            <Notice
              role="alert"
              tone="error"
              onDismiss={() => setExportState({ status: "idle" })}
            >
              <strong className="font-medium text-foreground">
                The Excel file could not be made.
              </strong>{" "}
              Try Export to Excel again. If it keeps failing, reload this page.
            </Notice>
          )}
        </div>
      )}

      <SummaryRow summary={summary} />
      <FindingsTable findings={findings} reviews={reviews} onOpen={openFinding} />
      <SourcesPanel usage={usage} />

      <EvidenceDrawer
        finding={selected}
        open={drawerOpen}
        review={selected ? reviews[selected.id] : undefined}
        onOpenChange={setDrawerOpen}
        onReview={mark}
      />
    </div>
  )
}

type ExportState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "done"; fileName: string }
  | { status: "failed" }

function Notice({
  children,
  role,
  tone,
  onDismiss,
}: {
  children: React.ReactNode
  role?: "status" | "alert"
  tone?: "error"
  onDismiss?: () => void
}) {
  const Icon = tone === "error" ? AlertCircle : Info
  return (
    <div
      role={role}
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm text-muted-foreground",
        tone === "error"
          ? "border-destructive/30 bg-destructive/[0.06]"
          : "border-border bg-white/[0.02]"
      )}
    >
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", tone === "error" && "text-destructive")}
        aria-hidden
      />
      <p className="min-w-0 flex-1 leading-relaxed">{children}</p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss this notice"
          className="-my-2 -mr-2 grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  )
}

function EmptyResults() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-12 pb-16 sm:px-8 sm:pt-20">
      <div className="rounded-2xl border border-border bg-card p-8 shadow-card">
        <h1 className="text-xl font-semibold tracking-tight">No results yet</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Results appear here after you analyze a deal. They stay in this browser tab only.
        </p>
        <Link
          href="/new"
          className="mt-6 inline-flex h-11 items-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-[background-color,transform] duration-150 hover:-translate-y-px hover:bg-[#fb8a3c] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none active:translate-y-px"
        >
          Start an investigation
        </Link>
      </div>
    </div>
  )
}

function ResultsSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 pt-8 pb-16 sm:px-8 sm:pt-10"
      aria-busy="true"
    >
      <span className="sr-only" role="status">
        Loading results…
      </span>
      <Skeleton className="h-16 w-2/3" />
      <div className="grid grid-cols-3 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  )
}
