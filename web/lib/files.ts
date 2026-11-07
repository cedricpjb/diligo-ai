// File rules for the two upload areas.
//
// Types come from docs/API.md. The limits match the backend (api/src/uploads.ts,
// api/src/app.ts), so a problem shows here, before submitting, instead of as a
// server error afterwards:
//   - 15 MiB per file (audio too), and no empty files
//   - 25 MiB for the whole request
//   - at most 20 files, counted across both areas
//   - file names unique across both areas

export type FileKind = "pdf" | "txt" | "csv" | "audio"

export interface UploadItem {
  id: string
  file: File
  kind: FileKind
}

export interface Rejection {
  name: string
  reason: string
}

export interface ZoneRules {
  /** Lower-case extensions without the dot. */
  extensions: string[]
  /** Shown to the analyst, e.g. "PDF, TXT, MP3, WAV or M4A". */
  typesLabel: string
}

export const MAX_FILE_BYTES = 15 * 1024 * 1024
export const MAX_REQUEST_BYTES = 25 * 1024 * 1024
export const MAX_FILES = 20
export const MAX_NAME_LENGTH = 200

/** Each file travels with part headers and boundaries, which count toward the request limit. */
const PART_OVERHEAD_BYTES = 1024

const AUDIO = ["mp3", "wav", "m4a"]

export const CLAIMS_RULES: ZoneRules = {
  extensions: ["pdf", "txt", ...AUDIO],
  typesLabel: "PDF, TXT, MP3, WAV or M4A",
}

export const PROOF_RULES: ZoneRules = {
  extensions: ["pdf", "csv", "txt"],
  typesLabel: "PDF, CSV or TXT",
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase()
}

export function kindOf(name: string): FileKind {
  const ext = extensionOf(name)
  if (AUDIO.includes(ext)) return "audio"
  if (ext === "csv") return "csv"
  if (ext === "txt") return "txt"
  return "pdf"
}

export function acceptAttribute(rules: ZoneRules): string {
  return rules.extensions.map((ext) => `.${ext}`).join(",")
}

/** What the request will weigh: file bytes plus the multipart overhead of each part. */
export function requestBytes(items: UploadItem[]): number {
  return items.reduce((sum, item) => sum + item.file.size + PART_OVERHEAD_BYTES, 0)
}

/**
 * Why `file` cannot join `current` (every file already chosen, in both areas), or null.
 * Type is checked per area elsewhere; these are the limits shared by the whole request.
 */
function limitProblem(file: File, current: UploadItem[]): string | null {
  if (/[\\/\u0000-\u001f]/.test(file.name)) {
    return "The file name has a slash or a control character. Rename it and add it again."
  }
  if (file.name.length > MAX_NAME_LENGTH) {
    return `The file name is longer than ${MAX_NAME_LENGTH} characters. Rename it and add it again.`
  }
  if (file.size === 0) return "This file is empty. Choose a copy that has content."
  if (file.size > MAX_FILE_BYTES) {
    return `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)} per file, so split or compress it.`
  }
  if (current.some((item) => item.file.name === file.name)) {
    return "A file with this name is already added. File names must be unique across both areas, so rename one."
  }
  if (current.length >= MAX_FILES) {
    return `At most ${MAX_FILES} files are allowed across both areas. Remove one to add this.`
  }
  const total = requestBytes(current) + file.size + PART_OVERHEAD_BYTES
  if (total > MAX_REQUEST_BYTES) {
    return `Adding this file would take the upload to ${formatBytes(total)}. The limit is ${formatBytes(MAX_REQUEST_BYTES)} for all files together.`
  }
  return null
}

/**
 * Splits picked files into accepted items and rejections with a plain reason.
 * `existing` is every file already chosen in both areas, because the limits are shared.
 */
export function screenFiles(
  incoming: File[],
  existing: UploadItem[],
  rules: ZoneRules
): { accepted: UploadItem[]; rejected: Rejection[] } {
  const accepted: UploadItem[] = []
  const rejected: Rejection[] = []

  for (const file of incoming) {
    const ext = extensionOf(file.name)
    const problem = !rules.extensions.includes(ext)
      ? ext
        ? `.${ext} files are not accepted here. Use ${rules.typesLabel}.`
        : `This file has no extension. Use ${rules.typesLabel}.`
      : limitProblem(file, [...existing, ...accepted])

    if (problem) {
      rejected.push({ name: file.name, reason: problem })
      continue
    }
    accepted.push({ id: `${file.name}:${crypto.randomUUID()}`, file, kind: kindOf(file.name) })
  }

  return { accepted, rejected }
}

/** The same limits, checked once more over everything about to be sent. Null when it is fine. */
export function requestError(items: UploadItem[]): string | null {
  const checked: UploadItem[] = []
  for (const item of items) {
    const problem = limitProblem(item.file, checked)
    if (problem) return `${item.file.name}: ${problem}`
    checked.push(item)
  }
  return null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  // Round up, so a file one byte over a limit never reads as exactly the limit.
  const rounded = Math.ceil(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`
}
