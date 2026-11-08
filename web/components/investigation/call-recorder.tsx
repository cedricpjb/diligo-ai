"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { AlertCircle, Mic, RotateCcw, Square, Trash2 } from "lucide-react"

import type { UploadItem } from "@/lib/files"
import {
  CONVERSION_MESSAGE,
  MAX_RECORDING_MS,
  RECORDING_BITRATE,
  UNSUPPORTED_MESSAGE,
  convertToWav,
  formatElapsed,
  microphoneMessage,
  pickRecordingFormat,
  type RecordingFormat,
} from "@/lib/recording"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface CallRecorderProps {
  /** The recording currently in the "What they said" list, if any. */
  recording: UploadItem | null
  disabled?: boolean
  /** Adds the finished recording to the claims list. Returns a message when it cannot be added. */
  onRecorded: (file: File) => string | null
  onRemove: () => void
  /** Reports whether a recording is in progress, so the form can hold off analysis until it has stopped. */
  onActiveChange?: (active: boolean) => void
}

type Status = "idle" | "requesting" | "recording" | "converting"

// Browser support is only known in the browser. The server render says nothing about it (undefined), so a browser
// that can record never flashes a "not available" note before its buttons appear. null means unsupported.
const noSubscribe = () => () => {}
function readSupport(): RecordingFormat | null {
  if (!window.isSecureContext) return null
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return null
  return pickRecordingFormat((mimeType) => MediaRecorder.isTypeSupported(mimeType))
}

export function CallRecorder({ recording, disabled, onRecorded, onRemove, onActiveChange }: CallRecorderProps) {
  const format = useSyncExternalStore(noSubscribe, readSupport, () => undefined)
  const [status, setStatus] = useState<Status>("idle")
  const [elapsed, setElapsed] = useState(0)
  const [note, setNote] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const discardRef = useRef(false)

  // The callback runs when recording stops, which can be minutes later. Read the latest one at that moment, so
  // files added or removed while recording are taken into account.
  const latest = useRef({ onRecorded, onActiveChange })
  useEffect(() => {
    latest.current = { onRecorded, onActiveChange }
  })

  function clearTimer() {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
  }

  function releaseMicrophone() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  // Stop the microphone and the timer if the form goes away while recording. Nothing is kept.
  useEffect(() => {
    return () => {
      discardRef.current = true
      clearTimer()
      if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop()
      releaseMicrophone()
      latest.current.onActiveChange?.(false)
    }
  }, [])

  async function finish(mimeType: string) {
    clearTimer()
    releaseMicrophone()
    const chunks = chunksRef.current
    chunksRef.current = []
    recorderRef.current = null
    if (discardRef.current) return
    setStatus("converting")
    try {
      const blob = new Blob(chunks, { type: mimeType })
      const isMp4 = mimeType.startsWith("audio/mp4")
      const file = isMp4
        ? new File([blob], "recording.m4a", { type: "audio/mp4" })
        : new File([await convertToWav(blob)], "recording.wav", { type: "audio/wav" })
      const problem = latest.current.onRecorded(file)
      setNote(problem)
    } catch {
      setNote(CONVERSION_MESSAGE)
    } finally {
      setStatus("idle")
      setElapsed(0)
    }
  }

  async function start() {
    if (!format) return
    setNote(null)
    setStatus("requesting")
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      setStatus("idle")
      setNote(microphoneMessage(error instanceof DOMException ? error.name : undefined))
      return
    }
    discardRef.current = false
    streamRef.current = stream
    chunksRef.current = []
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: RECORDING_BITRATE })
    } catch {
      releaseMicrophone()
      setStatus("idle")
      setNote(UNSUPPORTED_MESSAGE)
      return
    }
    const recordedType = recorder.mimeType || format.mimeType
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.onstop = () => void finish(recordedType)
    recorderRef.current = recorder
    recorder.start(1000)
    startedRef.current = Date.now()
    setElapsed(0)
    setStatus("recording")
    timerRef.current = setInterval(() => {
      const ms = Date.now() - startedRef.current
      if (ms >= MAX_RECORDING_MS) {
        stop()
        setNote("The recording stopped at six minutes, the longest one kept.")
        return
      }
      setElapsed(ms)
    }, 250)
  }

  function stop() {
    clearTimer()
    const recorder = recorderRef.current
    if (recorder && recorder.state !== "inactive") recorder.stop()
  }

  const unsupported = format === null
  const busy = status !== "idle"
  const checking = format === undefined

  // Tell the form whenever a recording is in progress (including while the microphone is being asked for).
  useEffect(() => {
    latest.current.onActiveChange?.(busy)
  }, [busy])

  return (
    <section
      aria-labelledby="call-recorder-title"
      className="flex flex-col rounded-2xl border border-border bg-card p-5 shadow-card sm:p-6"
    >
      <header className="mb-4 flex items-baseline gap-3">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">02b</span>
        <div className="min-w-0">
          <h2 id="call-recorder-title" className="text-base font-semibold tracking-tight">
            Record the call
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Record management speaking, then check it against the proof. Recordings are added to the list above.
          </p>
        </div>
      </header>

      {checking ? null : unsupported ? (
        <p className="text-sm text-muted-foreground">{UNSUPPORTED_MESSAGE}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {status === "recording" ? (
              <Button
                type="button"
                variant="destructive"
                onClick={stop}
                disabled={disabled}
                className="h-10 gap-2 rounded-lg px-4"
              >
                <Square className="size-3.5" aria-hidden />
                Stop recording
              </Button>
            ) : recording ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void start()}
                disabled={disabled || busy}
                className="h-10 gap-2 rounded-lg px-4"
              >
                <RotateCcw className="size-4" aria-hidden />
                Record again
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => void start()}
                disabled={disabled || busy}
                className="h-10 gap-2 rounded-lg px-4"
              >
                <Mic className="size-4" aria-hidden />
                Start recording
              </Button>
            )}

            {recording && status !== "recording" && (
              <Button
                type="button"
                variant="ghost"
                onClick={onRemove}
                disabled={disabled || busy}
                className="h-10 gap-2 rounded-lg px-3"
              >
                <Trash2 className="size-4" aria-hidden />
                Remove recording
              </Button>
            )}

            <span
              role="timer"
              aria-live="off"
              className={cn(
                "font-mono text-sm tabular-nums",
                status === "recording" ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {status === "recording" ? formatElapsed(elapsed) : status === "converting" ? "Preparing…" : status === "requesting" ? "Waiting for the microphone…" : ""}
            </span>
          </div>

          {recording && status === "idle" && <Preview key={recording.id} file={recording.file} />}

          {note && (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {note}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function Preview({ file }: { file: File }) {
  // One URL per recording. It is revoked when the recording is replaced or removed, and when the form unmounts.
  const [url] = useState(() => URL.createObjectURL(file))
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">Preview of the recording</span>
      <audio controls preload="metadata" src={url} className="w-full max-w-md" aria-label="Preview of the recording" />
    </div>
  )
}
