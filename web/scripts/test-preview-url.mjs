// Regression check for lib/preview-url.ts under React Strict Mode. Strict Mode mounts, unmounts and mounts again in
// development. The URL on screen must still be one that has not been revoked. Runs in jsdom with a real React render.
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no object URLs, so record every create and revoke.
const created = []
const revoked = []
URL.createObjectURL = (blob) => {
  const url = `blob:test/${created.length + 1}`
  created.push({ url, blob })
  return url
}
URL.revokeObjectURL = (url) => revoked.push(url)

const React = await import("react")
const { createRoot } = await import("react-dom/client")
const { usePreviewUrl } = await import("../lib/preview-url.ts")

const { createElement: h, StrictMode, act } = React
function Probe({ file }) {
  const url = usePreviewUrl(file)
  return h("audio", { "data-testid": "player", src: url ?? null })
}

const container = document.getElementById("root")
const root = createRoot(container)
const shown = () => container.querySelector("audio").getAttribute("src")
const isLive = (url) => url && !revoked.includes(url)

const first = new Blob(["first"], { type: "audio/wav" })
await act(async () => root.render(h(StrictMode, null, h(Probe, { file: first }))))

// Strict Mode ran the effect, cleaned it up and ran it again: more than one URL was made, and the earlier ones were revoked.
assert.ok(created.length >= 2, "Strict Mode runs the effect twice on mount")
assert.ok(revoked.includes(created[0].url), "the first, discarded URL was revoked")
// What is on screen is a URL made for this blob, and it has not been revoked.
const onScreen = shown()
assert.ok(created.some(({ url, blob }) => url === onScreen && blob === first), "the preview points at a URL made for the recording")
assert.ok(isLive(onScreen), "the preview URL is still valid after Strict Mode's remount")

// A new recording: the old URL is revoked, the new one is shown and stays valid.
const second = new Blob(["second"], { type: "audio/wav" })
await act(async () => root.render(h(StrictMode, null, h(Probe, { file: second }))))
const replaced = shown()
assert.notEqual(replaced, onScreen)
assert.ok(revoked.includes(onScreen), "the replaced recording's URL is revoked")
assert.ok(isLive(replaced), "the new recording's URL is valid")
assert.ok(created.some(({ url, blob }) => url === replaced && blob === second))

// Unmounting revokes the URL that was shown.
await act(async () => root.unmount())
assert.ok(revoked.includes(replaced), "unmounting revokes the shown URL")

console.log("preview url: Strict Mode keeps the shown URL valid")
