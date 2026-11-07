import type { Metadata } from "next"

import { NewInvestigationForm } from "@/components/investigation/new-investigation-form"

export const metadata: Metadata = {
  title: "New investigation",
}

export default function NewInvestigationPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-8 pb-16 sm:px-8 sm:pt-12">
      <header className="mb-8 max-w-2xl sm:mb-10">
        <h1 className="text-[28px] leading-[1.15] font-semibold tracking-tight text-balance sm:text-4xl">
          Check what management said against the proof
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-pretty text-muted-foreground sm:text-base">
          Add the call or the deck, then the documents behind it. Every claim comes back as YES,
          NO or NEEDS REVIEW, with the quote that decided it.
        </p>
      </header>
      <NewInvestigationForm />
    </div>
  )
}
