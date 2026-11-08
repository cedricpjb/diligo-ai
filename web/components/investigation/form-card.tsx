import { cn } from "@/lib/utils"

interface FormCardProps {
  titleId: string
  step?: string
  title: string
  description: string
  className?: string
  children: React.ReactNode
}

/** One card on the New Investigation page: a step number, a heading and a helper line, then its content. */
export function FormCard({ titleId, step, title, description, className, children }: FormCardProps) {
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-card p-5 shadow-card sm:p-6",
        className
      )}
    >
      <header className="flex items-baseline gap-3">
        {step && <span className="font-mono text-xs text-muted-foreground tabular-nums">{step}</span>}
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
      </header>
      {children}
    </section>
  )
}
