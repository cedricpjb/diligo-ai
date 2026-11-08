"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, ArrowRight } from "lucide-react"

import { ApiError, checkClaims, isAbort, isSampleMode } from "@/lib/api"
import {
  CLAIMS_RULES,
  MAX_FILES,
  MAX_REQUEST_BYTES,
  PROOF_RULES,
  formatBytes,
  requestBytes,
  requestError,
  screenFiles,
  type Rejection,
  type UploadItem,
} from "@/lib/files"
import { saveInvestigation } from "@/lib/investigation-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { recordingFileName } from "@/lib/recording"
import { CallRecorder } from "./call-recorder"
import { FileDropzone } from "./file-dropzone"
import { ProcessingPanel, type ProcessingStep } from "./processing-panel"

type FieldErrors = Partial<Record<"dealName" | "ticker" | "claims" | "proof" | "request", string>>

type Phase =
  | { kind: "idle" }
  | { kind: "running"; active: number }
  | { kind: "finished" }
  | { kind: "failed"; message: string }

/** How long each step shows before the next one starts. The request itself is one call. */
const STEP_MS = 1400
const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/

export function NewInvestigationForm() {
  const router = useRouter()
  const [dealName, setDealName] = useState("")
  const [ticker, setTicker] = useState("")
  const [claims, setClaims] = useState<UploadItem[]>([])
  const [proof, setProof] = useState<UploadItem[]>([])
  const [claimsRejected, setClaimsRejected] = useState<Rejection[]>([])
  const [proofRejected, setProofRejected] = useState<Rejection[]>([])
  const [errors, setErrors] = useState<FieldErrors>({})
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  // The recording made in the browser, if there is one. It is an ordinary item in `claims`, found by id.
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const recording = claims.find((item) => item.id === recordingId) ?? null
  // True while the microphone is being used. Analysis waits until the recording has stopped and been added.
  const [recordingActive, setRecordingActive] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const dealNameRef = useRef<HTMLInputElement>(null)
  const tickerRef = useRef<HTMLInputElement>(null)
  const requestErrorRef = useRef<HTMLParagraphElement>(null)

  const audioCount = claims.filter((item) => item.kind === "audio").length
  const busy = phase.kind === "running" || phase.kind === "finished"

  const steps: ProcessingStep[] = buildSteps(audioCount, claims.length, proof.length, phase)

  // Warn before the tab closes while files are attached but not yet analyzed.
  const hasUnsentFiles = claims.length + proof.length > 0 && phase.kind !== "finished"
  useEffect(() => {
    if (!hasUnsentFiles) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [hasUnsentFiles])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  function addFiles(zone: "claims" | "proof", files: File[]) {
    const rules = zone === "claims" ? CLAIMS_RULES : PROOF_RULES
    const current = zone === "claims" ? claims : proof
    // The limits are shared, so every file in both areas counts.
    const { accepted, rejected } = screenFiles(files, [...claims, ...proof], rules)
    if (zone === "claims") {
      setClaims([...current, ...accepted])
      setClaimsRejected(rejected)
    } else {
      setProof([...current, ...accepted])
      setProofRejected(rejected)
    }
    if (accepted.length > 0) setErrors((prev) => ({ ...prev, [zone]: undefined, request: undefined }))
  }

  /**
   * Adds a finished recording to the claims list, replacing the previous recording. The new file goes through the
   * same rules as an upload. The old recording is removed only when the new one is accepted.
   */
  function addRecording(file: File): string | null {
    const others = claims.filter((item) => item.id !== recordingId)
    const existing = [...others, ...proof]
    const name = recordingFileName(
      existing.map((item) => item.file.name),
      file.name.endsWith(".m4a") ? "m4a" : "wav"
    )
    const { accepted, rejected } = screenFiles([new File([file], name, { type: file.type })], existing, CLAIMS_RULES)
    if (rejected.length > 0) return rejected[0]!.reason
    const item = accepted[0]!
    setClaims([...others, item])
    setRecordingId(item.id)
    setErrors((prev) => ({ ...prev, claims: undefined, request: undefined }))
    return null
  }

  function removeRecording() {
    setClaims((prev) => prev.filter((item) => item.id !== recordingId))
    setRecordingId(null)
    setErrors((prev) => ({ ...prev, request: undefined }))
  }

  function removeFile(zone: "claims" | "proof", id: string) {
    const drop = (items: UploadItem[]) => items.filter((item) => item.id !== id)
    if (zone === "claims") setClaims(drop)
    else setProof(drop)
    setErrors((prev) => ({ ...prev, request: undefined }))
  }

  function validate(): FieldErrors {
    const next: FieldErrors = {}
    if (!dealName.trim()) next.dealName = "Enter the company or deal name."
    if (ticker && !TICKER_PATTERN.test(ticker)) {
      next.ticker = "Use the exchange ticker, for example ACME or BRK.B."
    }
    if (claims.length === 0) next.claims = "Add at least one file of what management said."
    if (proof.length === 0) next.proof = "Add at least one proof document."
    // The upload limits again, over everything about to be sent, before any request.
    const limit = requestError([...claims, ...proof])
    if (limit) next.request = limit
    return next
  }

  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
  }

  async function analyze() {
    if (recordingActive) {
      setErrors({ request: "Stop the recording before you analyze, so it is included." })
      requestErrorRef.current?.focus()
      return
    }
    const found = validate()
    setErrors(found)
    if (Object.keys(found).length > 0) {
      if (found.dealName) dealNameRef.current?.focus()
      else if (found.ticker) tickerRef.current?.focus()
      else if (found.request) requestErrorRef.current?.focus()
      return
    }

    setClaimsRejected([])
    setProofRejected([])
    const controller = new AbortController()
    abortRef.current = controller
    const first = audioCount > 0 ? 0 : 1
    setPhase({ kind: "running", active: first })
    requestAnimationFrame(() =>
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    )

    // Walk the steps while the single request runs; hold on the last step until it answers.
    timerRef.current = setInterval(() => {
      setPhase((prev) =>
        prev.kind === "running" ? { kind: "running", active: Math.min(prev.active + 1, 2) } : prev
      )
    }, STEP_MS)

    try {
      const response = await checkClaims({
        claimsFiles: claims.filter((item) => item.kind !== "audio").map((item) => item.file),
        claimsAudio: claims.filter((item) => item.kind === "audio").map((item) => item.file),
        proofFiles: proof.map((item) => item.file),
        ticker: ticker || undefined,
        signal: controller.signal,
      })
      stopTimer()
      setPhase({ kind: "finished" })
      saveInvestigation({
        dealName: dealName.trim(),
        ticker: ticker || null,
        createdAt: new Date().toISOString(),
        sample: isSampleMode,
        response,
      })
      setTimeout(() => router.push("/results"), 500)
    } catch (error) {
      stopTimer()
      if (isAbort(error)) {
        setPhase({ kind: "idle" })
        return
      }
      const message =
        error instanceof ApiError ? error.message : "Something went wrong. Try again."
      setPhase({ kind: "failed", message })
    } finally {
      abortRef.current = null
    }
  }

  function cancel() {
    abortRef.current?.abort()
    stopTimer()
    setPhase({ kind: "idle" })
  }

  const fileCount = claims.length + proof.length

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy) void analyze()
      }}
      className="flex flex-col gap-5"
    >
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
        <legend className="sr-only">Investigation details and files</legend>

        <section
          aria-labelledby="deal-title"
          className="rounded-2xl border border-border bg-card p-5 shadow-card sm:p-6"
        >
          <header className="mb-5 flex items-baseline gap-3">
            <span className="font-mono text-xs text-muted-foreground tabular-nums">01</span>
            <div>
              <h2 id="deal-title" className="text-base font-semibold tracking-tight">
                The deal
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Name the company you are checking.
              </p>
            </div>
          </header>

          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <div className="flex flex-col gap-2">
              <Label htmlFor="deal-name">Company and deal name</Label>
              <Input
                ref={dealNameRef}
                id="deal-name"
                name="dealName"
                autoComplete="off"
                placeholder="Starter Co, Series B…"
                value={dealName}
                aria-invalid={errors.dealName ? true : undefined}
                aria-describedby={errors.dealName ? "deal-name-error" : undefined}
                onChange={(event) => {
                  setDealName(event.target.value)
                  if (errors.dealName) setErrors((prev) => ({ ...prev, dealName: undefined }))
                }}
                className="h-11 px-3.5 text-[15px]"
              />
              {errors.dealName && <FieldError id="deal-name-error">{errors.dealName}</FieldError>}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="ticker">
                Ticker <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                ref={tickerRef}
                id="ticker"
                name="ticker"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={10}
                placeholder="ACME…"
                value={ticker}
                aria-invalid={errors.ticker ? true : undefined}
                aria-describedby={errors.ticker ? "ticker-error" : undefined}
                onChange={(event) => {
                  setTicker(event.target.value.toUpperCase().replace(/\s/g, ""))
                  if (errors.ticker) setErrors((prev) => ({ ...prev, ticker: undefined }))
                }}
                className="h-11 px-3.5 font-mono text-[15px] uppercase tracking-wide placeholder:normal-case"
              />
              {errors.ticker && <FieldError id="ticker-error">{errors.ticker}</FieldError>}
            </div>
          </div>
        </section>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-5">
            <FileDropzone
              step="02"
              title="What they said"
              description="Call recordings, transcripts or the management deck."
              rules={CLAIMS_RULES}
              items={claims}
              rejections={claimsRejected}
              error={errors.claims}
              disabled={busy}
              onAdd={(files) => addFiles("claims", files)}
              onRemove={(id) => removeFile("claims", id)}
              onDismissRejections={() => setClaimsRejected([])}
            />
            <CallRecorder
              recording={recording}
              disabled={busy}
              onRecorded={addRecording}
              onRemove={removeRecording}
              onActiveChange={setRecordingActive}
            />
          </div>
          <FileDropzone
            step="03"
            title="The proof"
            description="Finance reports, ledgers, contracts and filings."
            rules={PROOF_RULES}
            items={proof}
            rejections={proofRejected}
            error={errors.proof}
            disabled={busy}
            onAdd={(files) => addFiles("proof", files)}
            onRemove={(id) => removeFile("proof", id)}
            onDismissRejections={() => setProofRejected([])}
          />
        </div>
      </fieldset>

      <div ref={panelRef} className="scroll-mt-20">
        {busy ? (
          <ProcessingPanel dealName={dealName.trim()} steps={steps} onCancel={cancel} />
        ) : (
          <div className="flex flex-col gap-4">
            {phase.kind === "failed" && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/[0.06] px-5 py-4 text-sm"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                <div>
                  <p className="font-medium text-foreground">The check did not finish.</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {phase.message} Your files are still here.
                  </p>
                </div>
              </div>
            )}

            {errors.request && (
              <p
                id="request-error"
                ref={requestErrorRef}
                tabIndex={-1}
                role="alert"
                className="flex items-start gap-2 text-sm text-destructive outline-none"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {errors.request}
              </p>
            )}

            <div className="flex flex-col-reverse items-stretch justify-between gap-4 border-t border-border pt-5 sm:flex-row sm:items-center">
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {fileCount === 0
                  ? "Add files to both areas to start."
                  : summaryLine(claims.length, audioCount, proof.length, requestBytes([...claims, ...proof]))}
              </p>
              <Button
                type="submit"
                disabled={recordingActive}
                className="h-11 gap-2 rounded-lg px-6 text-[15px] font-semibold transition-[background-color,transform] duration-150 hover:-translate-y-px hover:bg-[#fb8a3c] active:translate-y-px active:scale-[0.985]"
              >
                {phase.kind === "failed" ? "Analyze again" : "Analyze"}
                <ArrowRight className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
        )}
      </div>
    </form>
  )
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="flex items-center gap-1.5 text-sm text-destructive">
      <AlertCircle className="size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  )
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

function summaryLine(claims: number, audio: number, proof: number, bytes: number) {
  const parts = [
    `What they said: ${plural(claims, "file", "files")}`,
    `Proof: ${plural(proof, "file", "files")}`,
  ]
  if (audio > 0) parts.push(`${plural(audio, "recording", "recordings")} to transcribe`)
  parts.push(
    `${claims + proof} of ${MAX_FILES} files`,
    `${formatBytes(bytes)} of ${formatBytes(MAX_REQUEST_BYTES)}`
  )
  return parts.join(" · ")
}

function buildSteps(
  audio: number,
  claimFiles: number,
  proofFiles: number,
  phase: Phase
): ProcessingStep[] {
  const base = [
    {
      id: "transcribe",
      label: "Transcribing",
      detail: audio > 0 ? plural(audio, "recording", "recordings") : "No audio",
    },
    {
      id: "extract",
      label: "Extracting claims",
      detail: plural(claimFiles, "source", "sources"),
    },
    {
      id: "check",
      label: "Checking evidence",
      detail: plural(proofFiles, "proof document", "proof documents"),
    },
  ]

  return base.map((step, index) => {
    if (index === 0 && audio === 0) return { ...step, state: "skipped" as const }
    if (phase.kind === "finished") return { ...step, state: "done" as const }
    if (phase.kind !== "running") return { ...step, state: "pending" as const }
    if (index < phase.active) return { ...step, state: "done" as const }
    if (index === phase.active) return { ...step, state: "active" as const }
    return { ...step, state: "pending" as const }
  })
}
