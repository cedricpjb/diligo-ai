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
    <section aria-labelledby="sources-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="sources-title" className="font-serif text-2xl font-medium tracking-tight">
          Sources
        </h2>
        <p className="text-xs text-muted-foreground">Every document behind these findings.</p>
      </div>

      {usage.length === 0 ? (
        <p className="border-t border-border py-6 text-sm text-muted-foreground">
          The server listed no sources for this check.
        </p>
      ) : (
        <ul className="grid border-b border-border sm:grid-cols-2 sm:gap-x-10">
          {usage.map(({ source, asClaim, asProof }) => {
            const href = safeHttpUrl(source.url)
            const Icon = source.type === "sec" ? Landmark : FileText
            return (
              <li
                key={`${source.type}:${source.name}`}
                className="flex items-start gap-3 border-t border-border py-4"
              >
                <span
                  aria-hidden
                  className="grid size-8 shrink-0 place-items-center rounded-[3px] border border-border text-muted-foreground"
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
