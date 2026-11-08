"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Play } from "lucide-react"

import { fetchClip, isAbort, type Clip } from "@/lib/api"
import { formatClipRange } from "@/lib/findings"
import type { Finding } from "@/lib/types"
import { Button } from "@/components/ui/button"

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; clip: Clip }
  | { status: "unavailable" }

/**
 * "Play quote" for a finding that came from audio. Renders nothing for text findings,
 * and for audio findings with no usable recording ID or timing.
 */
export function ClipPlayer({ finding }: { finding: Finding }) {
  const { audio_file_id: fileId, start_ms: startMs, end_ms: endMs } = finding
  const [state, setState] = useState<State>({ status: "idle" })
  const audioRef = useRef<HTMLAudioElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const urlRef = useRef<string | null>(null)

  // Stop any request and free the audio when this finding's drawer content goes away.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  if (!fileId || typeof startMs !== "number" || typeof endMs !== "number" || endMs <= startMs) {
    return null
  }

  async function play() {
    const audio = audioRef.current
    if (state.status === "ready" && audio) {
      // Play it again from the start of the quote.
      audio.currentTime = state.clip.mode === "whole-file" ? startMs! / 1000 : 0
      void audio.play().catch(() => {})
      return
    }
    if (state.status === "loading") return

    setState({ status: "loading" })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const clip = await fetchClip(fileId!, startMs!, endMs!, controller.signal)
      urlRef.current = clip.url
      setState({ status: "ready", clip })
    } catch (error) {
      if (!isAbort(error)) setState({ status: "unavailable" })
    }
  }

  const clip = state.status === "ready" ? state.clip : null

  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={play}
          disabled={state.status === "loading"}
          className="h-11 gap-2 rounded-[4px] border-brand/40 hover:border-brand/70"
        >
          {state.status === "loading" ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Play aria-hidden />
          )}
          Play quote
          <span className="font-normal text-muted-foreground tabular-nums">
            {formatClipRange(startMs, endMs)}
          </span>
        </Button>
      </div>

      {clip && (
        <audio
          ref={audioRef}
          controls
          autoPlay
          src={clip.url}
          className="h-10 w-full"
          onLoadedMetadata={(event) => {
            // A whole-file response holds the entire call: go to the quote. A cut clip is not seeked.
            if (clip.mode === "whole-file") event.currentTarget.currentTime = startMs / 1000
          }}
          onTimeUpdate={(event) => {
            if (clip.mode === "whole-file" && event.currentTarget.currentTime >= endMs / 1000) {
              event.currentTarget.pause()
            }
          }}
          onError={() => setState({ status: "unavailable" })}
        />
      )}

      {state.status === "unavailable" && (
        <p role="status" className="text-xs text-muted-foreground">
          Audio clip unavailable. Re-upload the call.
        </p>
      )}
    </div>
  )
}
