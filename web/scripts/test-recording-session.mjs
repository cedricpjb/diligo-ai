// Regression checks for lib/recording-session.ts: late permission grants, late conversions and restarts after
// dispose. Everything the browser would provide is a fake, so the rules run under plain Node.
import assert from "node:assert/strict"
import { RecordingSession } from "../lib/recording-session.ts"

const FORMAT = { mimeType: "audio/webm;codecs=opus", container: "webm" }

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// A stream whose tracks record whether they were stopped.
function fakeStream(label) {
  const tracks = [{ label, stopped: false, stop() { this.stopped = true } }]
  return { label, tracks, getTracks: () => tracks }
}

// A recorder that emits data and stop events on demand.
function fakeRecorder() {
  return {
    state: "inactive",
    mimeType: "",
    ondataavailable: null,
    onstop: null,
    started: false,
    stopped: 0,
    start() { this.state = "recording"; this.started = true },
    stop() {
      this.stopped++
      if (this.state === "inactive") return
      this.state = "inactive"
      this.onstop?.()
    },
    emitData(size) { this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) }) },
  }
}

function harness(overrides = {}) {
  const events = []
  const recorders = []
  let clock = 0
  const intervals = []
  const deps = {
    getUserMedia: overrides.getUserMedia ?? (async () => fakeStream("default")),
    createRecorder: (stream, format) => {
      const recorder = fakeRecorder()
      recorder.stream = stream; recorder.format = format
      recorders.push(recorder)
      return recorder
    },
    toUploadFile: overrides.toUploadFile ?? (async (blob) => ({ name: "recording.wav", size: blob.size })),
    now: () => clock,
    setInterval: (callback) => { intervals.push(callback); return intervals.length },
    clearInterval: () => {},
  }
  const session = new RecordingSession(deps, {
    status: (value) => events.push(["status", value]),
    elapsed: (value) => events.push(["elapsed", value]),
    note: (value) => events.push(["note", value]),
    recorded: (file) => { events.push(["recorded", file]); return null },
  })
  return { session, events, recorders, advance: (ms) => { clock += ms }, tick: () => intervals.forEach((fn) => fn()) }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// The case from the review: the form unmounts while the permission prompt is still open, then the user answers it.
{
  const grant = deferred()
  const stream = fakeStream("late")
  const h = harness({ getUserMedia: () => grant.promise })
  const started = h.session.start(FORMAT)
  assert.deepEqual(h.events, [["note", null], ["status", "requesting"]])
  h.session.dispose() // unmount
  const before = h.events.length
  grant.resolve(stream) // the permission is granted after unmount
  await started
  await flush()
  assert.equal(h.events.length, before, "no state update after unmount")
  assert.deepEqual(h.events.slice(before), [])
  assert.ok(stream.tracks.every((track) => track.stopped), "the late microphone stream is released immediately")
  assert.equal(h.recorders.length, 0, "no recorder is created for a stream that arrives after unmount")
}

// A late denial after unmount is also silent.
{
  const deny = deferred()
  const h = harness({ getUserMedia: () => deny.promise })
  const started = h.session.start(FORMAT)
  h.session.dispose()
  const before = h.events.length
  deny.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }))
  await started
  assert.equal(h.events.length, before)
}

// Unmount while a recording is running: the microphone stops at once and the audio is discarded.
{
  const stream = fakeStream("live")
  const h = harness({ getUserMedia: async () => stream })
  await h.session.start(FORMAT)
  h.recorders[0].emitData(100)
  h.session.dispose()
  assert.ok(stream.tracks.every((track) => track.stopped), "tracks stop at dispose, not later")
  const before = h.events.length
  await flush()
  assert.equal(h.events.length, before)
  assert.equal(h.recorders[0].state, "inactive")
}

// Unmount while the audio is being converted: a late result is discarded, never added to the claims list.
{
  const conversion = deferred()
  const stream = fakeStream("converting")
  const h = harness({ getUserMedia: async () => stream, toUploadFile: () => conversion.promise })
  await h.session.start(FORMAT)
  h.recorders[0].emitData(100)
  h.session.stop()
  await flush()
  assert.ok(h.events.some(([name, value]) => name === "status" && value === "converting"))
  h.session.dispose()
  const before = h.events.length
  conversion.resolve({ name: "recording.wav" })
  await flush()
  assert.equal(h.events.length, before, "no state update, and no recorded() call, after unmount")
  assert.ok(!h.events.some(([name]) => name === "recorded"))
  assert.ok(stream.tracks.every((track) => track.stopped))
}

// A late grant from an earlier, abandoned start must not take over a newer recording.
{
  const first = deferred(); const firstStream = fakeStream("first")
  const secondStream = fakeStream("second")
  let calls = 0
  const h = harness({ getUserMedia: () => (++calls === 1 ? first.promise : Promise.resolve(secondStream)) })
  const abandoned = h.session.start(FORMAT)
  h.session.dispose()
  await h.session.start(FORMAT) // a fresh start after the dispose records normally
  assert.equal(h.recorders.length, 1)
  assert.equal(h.recorders[0].stream, secondStream)
  first.resolve(firstStream)
  await abandoned
  assert.ok(firstStream.tracks.every((track) => track.stopped), "the abandoned grant is released")
  assert.ok(!secondStream.tracks.some((track) => track.stopped), "the live recording keeps its microphone")
  assert.equal(h.recorders.length, 1, "the abandoned grant creates no recorder")
}

// Normal path: start, stop, convert, hand over the file, return to idle.
{
  const stream = fakeStream("normal")
  const h = harness({ getUserMedia: async () => stream })
  await h.session.start(FORMAT)
  h.recorders[0].emitData(4000)
  h.session.stop()
  await flush()
  assert.deepEqual(h.events.filter(([name]) => name === "status").map(([, value]) => value),
    ["requesting", "recording", "converting", "idle"])
  const recorded = h.events.find(([name]) => name === "recorded")
  assert.ok(recorded, "the finished file is handed over")
  assert.equal(recorded[1].size, 4000)
  assert.ok(stream.tracks.every((track) => track.stopped))
  assert.equal(h.events.at(-1)[0], "status")
  assert.equal(h.session.active, false)
}

// Denied and missing microphones report a clear note and leave the session idle.
{
  const h = harness({ getUserMedia: async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }) } })
  await h.session.start(FORMAT)
  assert.deepEqual(h.events.at(-2), ["status", "idle"])
  assert.deepEqual(h.events.at(-1), ["note", "Microphone access was denied. Allow it in the browser settings to record, or upload a file instead."])
}

// Six minutes ends the recording by itself, with a note.
{
  const h = harness({ getUserMedia: async () => fakeStream("long") })
  await h.session.start(FORMAT)
  h.advance(6 * 60 * 1000)
  h.tick()
  await flush()
  assert.ok(h.events.some(([name, value]) => name === "note" && /six minutes/.test(value)))
  assert.equal(h.recorders[0].state, "inactive")
}

// No format means nothing starts: no permission prompt is requested.
{
  let asked = false
  const h = harness({ getUserMedia: async () => { asked = true; return fakeStream("never") } })
  await h.session.start(null)
  assert.equal(asked, false)
}

console.log("recording session: all checks passed")
