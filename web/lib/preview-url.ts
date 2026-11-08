// An object URL for playing a recording back. It is created and revoked by the same effect: created when the blob
// is attached, revoked when that effect is cleaned up. Under React Strict Mode the effect runs, is cleaned up and
// runs again on mount; each run makes its own URL, so the URL that is returned is never one that was revoked.
import { useEffect, useState } from "react"

interface Entry {
  source: Blob
  url: string
}

export function usePreviewUrl(source: Blob): string | null {
  const [entry, setEntry] = useState<Entry | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(source)
    // Writing the URL to state is what lets render use it. It is the only state write here: the effect owns the
    // URL's whole life, from creation to revocation, so the write cannot leave a dead URL behind.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntry({ source, url })
    return () => URL.revokeObjectURL(url)
  }, [source])

  // A URL only applies to the blob it was made from. Until the effect runs for a new blob, nothing is returned.
  return entry !== null && entry.source === source ? entry.url : null
}
