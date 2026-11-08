// Call recording: format choice, WAV conversion and messages. The browser APIs are used only inside functions
// that are called from the recorder, so the pure parts run under plain Node for the tests.
//
// The backend accepts claims_audio as mp3, wav or m4a (docs/API.md). Browsers record in two families:
//   - audio/mp4 (Safari): sent as-is, as recording.m4a.
//   - audio/webm (Chrome, Firefox): decoded and re-encoded here as 16 kHz mono 16-bit WAV, recording.wav.
// That keeps six minutes of speech far below the 15 MiB per-file limit (about 11.5 MB).

/** The longest recording. It stops by itself here, so the WAV stays under the per-file limit. */
export const MAX_RECORDING_MS = 6 * 60 * 1000
/** Speech-quality target for the WAV: enough for transcription, and small. */
export const WAV_SAMPLE_RATE = 16000
/** Requested encoder bitrate. Low, because the recording is only for transcription. */
export const RECORDING_BITRATE = 64000

export interface RecordingFormat {
  mimeType: string
  /** The container the recording is in: mp4 is sent as m4a; webm is converted to wav. */
  container: "mp4" | "webm"
}

/** Preferred order: mp4 needs no conversion, so it wins when the browser can record it. */
const CANDIDATES: RecordingFormat[] = [
  { mimeType: "audio/mp4", container: "mp4" },
  { mimeType: "audio/webm;codecs=opus", container: "webm" },
  { mimeType: "audio/webm", container: "webm" },
]

export function pickRecordingFormat(
  isTypeSupported: (mimeType: string) => boolean
): RecordingFormat | null {
  return CANDIDATES.find((candidate) => isTypeSupported(candidate.mimeType)) ?? null
}

/** `recording.wav`, or `recording-2.wav`, `recording-3.wav`… when the name is already taken. */
export function recordingFileName(taken: string[], extension: "wav" | "m4a"): string {
  const names = new Set(taken.map((name) => name.toLowerCase()))
  let candidate = `recording.${extension}`
  for (let n = 2; names.has(candidate); n++) candidate = `recording-${n}.${extension}`
  return candidate
}

/**
 * 16-bit PCM mono WAV from float samples in [-1, 1]. Out-of-range samples are clipped, never wrapped.
 * Returns the complete file, header included.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  text(8, "WAVE")
  text(12, "fmt ")
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  text(36, "data")
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, clipped < 0 ? Math.round(clipped * 0x8000) : Math.round(clipped * 0x7fff), true)
  }
  return buffer
}

/** The note shown when getUserMedia fails. Says what to do next; never a stack or a browser message. */
export function microphoneMessage(errorName: string | undefined): string {
  if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    return "Microphone access was denied. Allow it in the browser settings to record, or upload a file instead."
  }
  if (errorName === "NotFoundError" || errorName === "OverconstrainedError") {
    return "No microphone was found. Upload a file instead."
  }
  return "The microphone could not be started. Upload a file instead."
}

export const UNSUPPORTED_MESSAGE =
  "Recording is not available in this browser, or this page is not on a secure address (HTTPS or localhost). Upload a file instead."

export const CONVERSION_MESSAGE =
  "This recording could not be converted. Record again, or upload a file instead."

/** Elapsed time as m:ss, or h:mm:ss past an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`
}

/** Decodes a webm recording and re-encodes it as 16 kHz mono WAV. Browser-only. */
export async function convertToWav(blob: Blob): Promise<ArrayBuffer> {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const decodeContext = new Context()
  let decoded: AudioBuffer
  try {
    decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer())
  } finally {
    void decodeContext.close()
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * WAV_SAMPLE_RATE))
  // An offline context resamples and downmixes to mono in one render, without a real output device.
  const offline = new OfflineAudioContext(1, frames, WAV_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return encodeWav(rendered.getChannelData(0), WAV_SAMPLE_RATE)
}
