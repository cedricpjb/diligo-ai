import { cn } from "@/lib/utils"

/** The Diligo.ai mark: a document corner with a check through it. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg border border-brand/35 bg-brand/10 text-brand",
        className
      )}
    >
      <svg viewBox="0 0 20 20" fill="none" className="size-4">
        <path
          d="M5 2.75h6.5L15.25 6.5v10.75H5z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="m7.75 11 1.75 1.75 3.25-3.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}
