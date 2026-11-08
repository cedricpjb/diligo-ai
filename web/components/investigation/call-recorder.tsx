"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { AlertCircle, Mic, RotateCcw, Square, Trash2 } from "lucide-react"

import type { UploadItem } from "@/lib/files"
import {
  RECORDING_BITRATE,
  UNSUPPORTED_MESSAGE,
  formatElapsed,
  pickRecordingFormat,
  toUploadFile,
  type RecordingFormat,
} from "@/lib/recording"
import {
  RecordingSession,
  type SessionDeps,
  type SessionStatus,
  type StreamLike,
} from "@/lib/recording-session"
import { usePreviewUrl } from "@/lib/preview-url"
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

// Browser support is only known in the browser. The server render says nothing about it (undefined), so a browser
// that can record never flashes a "not available" note before its buttons appear. null means unsupported.
const noSubscribe = () => () => {}
function readSupport(): RecordingFormat | null {
  if (!window.isSecureContext) return null
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return null
  return pickRecordingFormat((mimeType) => MediaRecorder.isTypeSupported(mimeType))
}

// The browser's own APIs, used only when the user acts (never at import or render time).
const browser: SessionDeps = {
  getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }) as Promise<StreamLike>,
  createRecorder: (stream, format) =>
    new MediaRecorder(stream as MediaStream, { mimeType: format.mimeType, audioBitsPerSecond: RECORDING_BITRATE }) as unknown as ReturnType<SessionDeps["createRecorder"]>,
  toUploadFile,
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

export function CallRecorder({ recording, disabled, onRecorded, onRemove, onActiveChange }: CallRecorderProps) {
  const format = useSyncExternalStore(noSubscribe, readSupport, () => undefined)
  const [status, setStatus] = useState<SessionStatus>("idle")
  const [elapsed, setElapsed] = useState(0)
  const [note, setNote] = useState<string | null>(null)

  // The callbacks run later (when recording stops, possibly minutes on). Read the latest ones at that moment.
  const latest = useRef({ onRecorded, onActiveChange })
  useEffect(() => {
    latest.current = { onRecorded, onActiveChange }
  })

  // One session per component. Its events write to state only while it is current; see recording-session.ts.
  // One session per component, created the first time the user starts a recording (never during render).
  const sessionRef = useRef<RecordingSession | null>(null)
  function session(): RecordingSession {
    if (sessionRef.current === null) {
      sessionRef.current = new RecordingSession(browser, {
        status: setStatus,
        elapsed: setElapsed,
        note: setNote,
        recorded: (file) => latest.current.onRecorded(file),
      })
    }
    return sessionRef.current
  }

  // Ends every pending permission request, conversion and recording when the form goes away. Strict Mode runs
  // this cleanup once on mount; the session starts again cleanly, so nothing else is needed.
  useEffect(() => {
    return () => {
      sessionRef.current?.dispose()
      latest.current.onActiveChange?.(false)
    }
  }, [])

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
                onClick={() => sessionRef.current?.stop()}
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
                onClick={() => void session().start(format ?? null)}
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
                onClick={() => void session().start(format ?? null)}
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
              {status === "recording"
                ? formatElapsed(elapsed)
                : status === "converting"
                  ? "Preparing…"
                  : status === "requesting"
                    ? "Waiting for the microphone…"
                    : ""}
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
  const url = usePreviewUrl(file)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">Preview of the recording</span>
      {url && (
        <audio controls preload="metadata" src={url} className="w-full max-w-md" aria-label="Preview of the recording" />
      )}
    </div>
  )
}
