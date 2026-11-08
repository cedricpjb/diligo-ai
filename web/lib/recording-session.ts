// The recording state machine, separate from React and from the browser. The component supplies the real browser
// APIs through SessionDeps and receives state through SessionEvents, so the lifetime rules can be tested under Node.
//
// Lifetime rule: every operation belongs to a generation. dispose() ends the current generation. Anything that
// finishes later (a permission prompt answered after the form closed, a conversion still running) is released or
// discarded and reports nothing. Nothing is applied to state after dispose().

import {
  MAX_RECORDING_MS,
  UNSUPPORTED_MESSAGE,
  CONVERSION_MESSAGE,
  microphoneMessage,
  type RecordingFormat,
} from "./recording.ts"

export type SessionStatus = "idle" | "requesting" | "recording" | "converting"

/** The parts of MediaStream and MediaRecorder this module uses. The browser objects satisfy them. */
export interface StreamLike {
  getTracks(): { stop(): void }[]
}
export interface RecorderLike {
  readonly state: "inactive" | "recording" | "paused"
  readonly mimeType?: string
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start(timeslice?: number): void
  stop(): void
}

export interface SessionDeps {
  getUserMedia(): Promise<StreamLike>
  createRecorder(stream: StreamLike, format: RecordingFormat): RecorderLike
  /** Turns the recorded blob into the file that is uploaded (mp4 as-is, webm converted to WAV). */
  toUploadFile(blob: Blob, mimeType: string): Promise<File>
  now(): number
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface SessionEvents {
  status(status: SessionStatus): void
  elapsed(ms: number): void
  note(text: string | null): void
  /** Adds the finished file to the claims list. Returns a message when the file cannot be added. */
  recorded(file: File): string | null
}

interface Live {
  recorder: RecorderLike
  stream: StreamLike
  timer: unknown
  finish: () => void
}

function stopTracks(stream: StreamLike) {
  for (const track of stream.getTracks()) track.stop()
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : undefined
}

export class RecordingSession {
  private generation = 0
  private busy = false
  private live: Live | null = null

  private readonly deps: SessionDeps
  private readonly events: SessionEvents

  constructor(deps: SessionDeps, events: SessionEvents) {
    this.deps = deps
    this.events = events
  }

  /** True while a start is waiting for the microphone, or a recording or its conversion is in progress. */
  get active(): boolean {
    return this.busy
  }

  async start(format: RecordingFormat | null): Promise<void> {
    if (!format || this.busy) return
    const token = ++this.generation
    this.busy = true
    this.events.note(null)
    this.events.status("requesting")

    let stream: StreamLike
    try {
      stream = await this.deps.getUserMedia()
    } catch (error) {
      // Ignore a failure that arrives after dispose(): there is nobody to tell.
      if (token !== this.generation) return
      this.busy = false
      this.events.status("idle")
      this.events.note(microphoneMessage(errorName(error)))
      return
    }
    // The permission was granted after the session ended (the form unmounted, or the user left). Release the
    // microphone at once and change nothing else.
    if (token !== this.generation) {
      stopTracks(stream)
      return
    }

    let recorder: RecorderLike
    try {
      recorder = this.deps.createRecorder(stream, format)
    } catch {
      stopTracks(stream)
      this.busy = false
      this.events.status("idle")
      this.events.note(UNSUPPORTED_MESSAGE)
      return
    }

    const chunks: Blob[] = []
    const startedAt = this.deps.now()
    const finish = () => this.finish(token, recorder.mimeType || format.mimeType, chunks, stream)
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.onstop = finish
    recorder.start(1000)

    const timer = this.deps.setInterval(() => this.tick(token, startedAt), 250)
    this.live = { recorder, stream, timer, finish }
    this.events.status("recording")
    this.events.elapsed(0)
  }

  stop(): void {
    const live = this.live
    if (!live) return
    this.live = null
    this.deps.clearInterval(live.timer)
    if (live.recorder.state !== "inactive") live.recorder.stop() // its onstop will call finish()
    else live.finish()
  }

  /** The owner is going away (unmount). Ends every pending operation, stops the microphone, reports nothing. */
  dispose(): void {
    this.generation++
    this.busy = false
    const live = this.live
    this.live = null
    if (!live) return
    this.deps.clearInterval(live.timer)
    stopTracks(live.stream)
    if (live.recorder.state !== "inactive") live.recorder.stop()
  }

  private tick(token: number, startedAt: number): void {
    if (token !== this.generation || !this.live) return
    const ms = this.deps.now() - startedAt
    if (ms >= MAX_RECORDING_MS) {
      this.stop()
      this.events.note("The recording stopped at six minutes, the longest one kept.")
      return
    }
    this.events.elapsed(ms)
  }

  private async finish(token: number, mimeType: string, chunks: Blob[], stream: StreamLike): Promise<void> {
    stopTracks(stream)
    if (token !== this.generation) return // disposed: discard the audio, report nothing
    if (this.live?.stream === stream) this.live = null
    this.events.status("converting")

    let problem: string | null
    try {
      const file = await this.deps.toUploadFile(new Blob(chunks, { type: mimeType }), mimeType)
      // A conversion that finishes after dispose() is discarded: it must not reach the claims list or the state.
      if (token !== this.generation) return
      problem = this.events.recorded(file)
    } catch {
      if (token !== this.generation) return
      problem = CONVERSION_MESSAGE
    }
    this.busy = false
    this.events.note(problem)
    this.events.elapsed(0)
    this.events.status("idle")
  }
}
