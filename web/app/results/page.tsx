import type { Metadata } from "next"

import { ResultsStub } from "./results-stub"

export const metadata: Metadata = {
  title: "Results",
}

// Stage 1 placeholder: confirms the analysis landed. The full Results screen is Stage 2.
export default function ResultsPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-8 pb-16 sm:px-8 sm:pt-12">
      <ResultsStub />
    </div>
  )
}
