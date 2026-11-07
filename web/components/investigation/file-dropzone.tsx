"use client"

import { useId, useRef, useState } from "react"
import {
  AlertCircle,
  FileAudio,
  FileSpreadsheet,
  FileText,
  Upload,
  X,
} from "lucide-react"

import {
  acceptAttribute,
  extensionOf,
  formatBytes,
  type FileKind,
  type Rejection,
  type UploadItem,
  type ZoneRules,
} from "@/lib/files"
import { cn } from "@/lib/utils"

interface FileDropzoneProps {
  step: string
  title: string
  description: string
  rules: ZoneRules
  items: UploadItem[]
  rejections: Rejection[]
  /** Form-level error, e.g. "Add at least one file". */
  error?: string
  disabled?: boolean
  onAdd: (files: File[]) => void
  onRemove: (id: string) => void
  onDismissRejections: () => void
}

const KIND_ICON: Record<FileKind, typeof FileText> = {
  pdf: FileText,
  txt: FileText,
  csv: FileSpreadsheet,
  audio: FileAudio,
}

export function FileDropzone({
  step,
  title,
  description,
  rules,
  items,
  rejections,
  error,
  disabled,
  onAdd,
  onRemove,
  onDismissRejections,
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const baseId = useId()
  const headingId = `${baseId}-title`
  const hintId = `${baseId}-hint`
  const errorId = `${baseId}-error`

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return
    onAdd(Array.from(list))
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col rounded-2xl border border-border bg-card p-5 shadow-card sm:p-6"
    >
      <header className="mb-4 flex items-baseline gap-3">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{step}</span>
        <div className="min-w-0">
          <h2 id={headingId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
      </header>

      <div
        onDragEnter={(event) => {
          event.preventDefault()
          if (disabled) return
          dragDepth.current++
          setDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = disabled ? "none" : "copy"
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          if (disabled) return
          handleFiles(event.dataTransfer.files)
        }}
        className={cn(
          "group relative rounded-xl border border-dashed transition-[border-color,background-color] duration-150",
          dragging
            ? "border-brand bg-brand/[0.06]"
            : error
              ? "border-destructive/60 bg-destructive/[0.04]"
              : "border-white/15 bg-white/[0.015] hover:border-white/25 hover:bg-white/[0.03]",
          disabled && "pointer-events-none opacity-60"
        )}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
          className="flex w-full flex-col items-center gap-3 rounded-xl px-6 py-8 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring sm:py-10"
        >
          <span
            aria-hidden
            className={cn(
              "grid size-11 place-items-center rounded-full border border-border bg-surface-raised text-muted-foreground transition-[color,transform] duration-150",
              dragging ? "-translate-y-0.5 text-brand" : "group-hover:text-foreground"
            )}
          >
            <Upload className="size-5" />
          </span>
          <span className="text-sm">
            <span className="font-medium text-foreground">
              {dragging ? (
                "Drop to add the files"
              ) : (
                <>
                  <span className="pointer-coarse:hidden">Drag files here or choose files</span>
                  <span className="hidden pointer-coarse:inline">Choose files</span>
                </>
              )}
            </span>
          </span>
          <span id={hintId} className="text-xs text-muted-foreground">
            {rules.typesLabel}
          </span>
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={acceptAttribute(rules)}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            handleFiles(event.target.files)
            event.target.value = ""
          }}
        />
      </div>

      {error && (
        <p id={errorId} role="alert" className="mt-3 flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {rejections.length > 0 && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3.5 py-3 text-sm"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden />
              {rejections.length === 1
                ? "1 file was not added"
                : `${rejections.length} files were not added`}
            </p>
            <button
              type="button"
              onClick={onDismissRejections}
              className="-m-2 grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="Dismiss file errors"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <ul className="mt-2 space-y-1.5 pl-6">
            {rejections.map((rejection, index) => (
              <li key={`${rejection.name}-${index}`} className="text-muted-foreground">
                <span className="break-all text-foreground">{rejection.name}</span>
                <span aria-hidden> · </span>
                <span className="sr-only">: </span>
                {rejection.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {items.length > 0 && (
        <ul aria-label={`${title} files`} className="mt-4 flex flex-col gap-2">
          {items.map((item) => {
            const Icon = KIND_ICON[item.kind]
            const ext = extensionOf(item.file.name).toUpperCase()
            return (
              <li
                key={item.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface-raised/60 py-2 pr-1.5 pl-3 animate-in fade-in-0 slide-in-from-top-1 duration-200"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground" title={item.file.name}>
                    {item.file.name}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {ext} · {formatBytes(item.file.size)}
                    {item.kind === "audio" && " · will be transcribed"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  disabled={disabled}
                  aria-label={`Remove ${item.file.name}`}
                  className="grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
