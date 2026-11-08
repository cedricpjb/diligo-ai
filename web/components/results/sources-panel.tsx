import { ExternalLink, FileText, Landmark } from "lucide-react"

import { safeHttpUrl, type SourceUsage } from "@/lib/findings"

function usageLine(asClaim: number, asProof: number): string {
  const parts: string[] = []
  if (asClaim > 0) parts.push(`Claim source for ${asClaim} ${asClaim === 1 ? "finding" : "findings"}`)
  if (asProof > 0) parts.push(`Proof for ${asProof} ${asProof === 1 ? "finding" : "findings"}`)
  return parts.length > 0 ? parts.join(" · ") : "Not cited by any finding"
}

export function SourcesPanel({ usage }: { usage: SourceUsage[] }) {
  return (
    <section aria-labelledby="sources-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="sources-title" className="text-base font-semibold tracking-tight">
          Sources
        </h2>
        <p className="text-sm text-muted-foreground">Every document behind these findings.</p>
      </div>

      {usage.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-white/15 px-5 py-6 text-sm text-muted-foreground">
          The server listed no sources for this check.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {usage.map(({ source, asClaim, asProof }) => {
            const href = safeHttpUrl(source.url)
            const Icon = source.type === "sec" ? Landmark : FileText
            return (
              <li
                key={`${source.type}:${source.name}`}
                className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4 shadow-card"
              >
                <span
                  aria-hidden
                  className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-raised text-muted-foreground"
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold break-all text-foreground">{source.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {source.type === "sec" ? "SEC filing" : "Uploaded file"}
                    {source.date && ` · ${source.date}`}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">{usageLine(asClaim, asProof)}</p>
                  {href && (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1 rounded-sm text-xs text-foreground underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      Open source
                      <ExternalLink className="size-3" aria-hidden />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
