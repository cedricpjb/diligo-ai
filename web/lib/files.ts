// File rules for the two upload areas. Allowed types come from docs/API.md.

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

// The contract sets no size limit. These stop obvious mistakes in the browser.
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024

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

/** Splits picked files into accepted items and rejections with a plain reason. */
export function screenFiles(
  incoming: File[],
  existing: UploadItem[],
  rules: ZoneRules
): { accepted: UploadItem[]; rejected: Rejection[] } {
  const accepted: UploadItem[] = []
  const rejected: Rejection[] = []
  const seen = new Set(existing.map((item) => fileKey(item.file)))

  for (const file of incoming) {
    const ext = extensionOf(file.name)
    if (!rules.extensions.includes(ext)) {
      rejected.push({
        name: file.name,
        reason: ext
          ? `.${ext} files are not accepted here. Use ${rules.typesLabel}.`
          : `This file has no extension. Use ${rules.typesLabel}.`,
      })
      continue
    }
    if (file.size === 0) {
      rejected.push({ name: file.name, reason: "This file is empty. Choose the saved copy with content." })
      continue
    }
    const kind = kindOf(file.name)
    const limit = kind === "audio" ? MAX_AUDIO_BYTES : MAX_DOCUMENT_BYTES
    if (file.size > limit) {
      rejected.push({
        name: file.name,
        reason: `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(limit)}, so split or compress it.`,
      })
      continue
    }
    const key = fileKey(file)
    if (seen.has(key)) {
      rejected.push({ name: file.name, reason: "This file is already in the list, so it was skipped." })
      continue
    }
    seen.add(key)
    accepted.push({ id: `${key}:${crypto.randomUUID()}`, file, kind })
  }

  return { accepted, rejected }
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
