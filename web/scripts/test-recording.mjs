// Regression checks for lib/recording.ts. Run with: npm test (Node 22.18+ runs .ts directly).
import assert from "node:assert/strict"
import {
  MAX_RECORDING_MS,
  WAV_SAMPLE_RATE,
  encodeWav,
  formatElapsed,
  microphoneMessage,
  pickRecordingFormat,
  recordingFileName,
} from "../lib/recording.ts"
import { MAX_FILE_BYTES } from "../lib/files.ts"

// Format: mp4 first (no conversion needed), then webm with opus, then plain webm; nothing when none is supported.
assert.deepEqual(pickRecordingFormat(() => true), { mimeType: "audio/mp4", container: "mp4" })
assert.deepEqual(
  pickRecordingFormat((type) => type.startsWith("audio/webm")),
  { mimeType: "audio/webm;codecs=opus", container: "webm" }
)
assert.deepEqual(pickRecordingFormat((type) => type === "audio/webm"), { mimeType: "audio/webm", container: "webm" })
assert.equal(pickRecordingFormat(() => false), null)

// File names: recording.wav, then recording-2.wav, -3…; taken names compare without case.
assert.equal(recordingFileName([], "wav"), "recording.wav")
assert.equal(recordingFileName(["call.mp3", "proof.pdf"], "m4a"), "recording.m4a")
assert.equal(recordingFileName(["Recording.WAV"], "wav"), "recording-2.wav")
assert.equal(recordingFileName(["recording.wav", "recording-2.wav"], "wav"), "recording-3.wav")

// WAV: 16 kHz, mono, 16-bit PCM, with correct sizes, and little-endian samples.
const samples = Float32Array.from([0, 1, -1, 0.5, 2, -2])
const wav = encodeWav(samples, WAV_SAMPLE_RATE)
const view = new DataView(wav)
const text = (offset, length) => String.fromCharCode(...new Uint8Array(wav, offset, length))
assert.equal(text(0, 4), "RIFF"); assert.equal(view.getUint32(4, true), 36 + samples.length * 2)
assert.equal(text(8, 4), "WAVE"); assert.equal(text(12, 4), "fmt "); assert.equal(view.getUint32(16, true), 16)
assert.equal(view.getUint16(20, true), 1) // PCM
assert.equal(view.getUint16(22, true), 1) // mono
assert.equal(view.getUint32(24, true), 16000)
assert.equal(view.getUint32(28, true), 32000) // byte rate
assert.equal(view.getUint16(32, true), 2) // block align
assert.equal(view.getUint16(34, true), 16)
assert.equal(text(36, 4), "data"); assert.equal(view.getUint32(40, true), samples.length * 2)
assert.equal(wav.byteLength, 44 + samples.length * 2)
const pcm = Array.from({ length: samples.length }, (_, i) => view.getInt16(44 + i * 2, true))
// 0 -> 0; 1 -> 32767; -1 -> -32768; out-of-range values are clipped, never wrapped around.
assert.deepEqual(pcm, [0, 32767, -32768, 16384, 32767, -32768])

// Six minutes of 16-bit mono WAV stays under the per-file limit that the upload rules enforce.
const sixMinutes = Math.round((MAX_RECORDING_MS / 1000) * WAV_SAMPLE_RATE)
assert.equal(MAX_RECORDING_MS, 6 * 60 * 1000)
assert.ok(44 + sixMinutes * 2 < MAX_FILE_BYTES, "six minutes of WAV must fit the per-file limit")

// Microphone messages say what to do next, for each failure the browser reports.
assert.match(microphoneMessage("NotAllowedError"), /denied.*upload a file instead/i)
assert.match(microphoneMessage("SecurityError"), /denied/i)
assert.match(microphoneMessage("NotFoundError"), /no microphone was found/i)
assert.match(microphoneMessage("OverconstrainedError"), /no microphone/i)
assert.match(microphoneMessage("AbortError"), /could not be started.*upload a file instead/i)
assert.equal(microphoneMessage(undefined), microphoneMessage("AbortError"))

// Elapsed time reads as m:ss, or h:mm:ss past an hour.
assert.equal(formatElapsed(0), "0:00")
assert.equal(formatElapsed(59_900), "0:59")
assert.equal(formatElapsed(65_000), "1:05")
assert.equal(formatElapsed(3_723_000), "1:02:03")
assert.equal(formatElapsed(-5), "0:00")

console.log("recording: all checks passed")
