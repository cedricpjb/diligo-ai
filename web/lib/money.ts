// Money is handled as integer cents. The API sends decimal strings such as
// "1250000.00" (docs/API.md); they are parsed digit by digit, never with
// parseFloat, so no float ever touches a dollar amount.

/** Parses a decimal USD string to integer cents. Returns null if it is not a plain decimal. */
export function toCents(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return null

  const [, sign, whole, fraction = ""] = match
  const padded = fraction.padEnd(3, "0")
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2))
  // Round half up on a third decimal digit, if the server ever sends one.
  if (Number(padded[2]) >= 5) cents += 1
  if (!Number.isSafeInteger(cents)) return null
  return sign ? -cents : cents
}

/** Formats integer cents as "$1,250,000.00". Pass `signed` to prefix "+" or "-". */
export function formatCents(cents: number, options: { signed?: boolean } = {}): string {
  const negative = cents < 0
  const abs = Math.abs(cents)
  const dollars = Math.trunc(abs / 100)
  const rest = String(abs % 100).padStart(2, "0")
  const grouped = dollars.toLocaleString("en-US")
  const sign = negative ? "-" : options.signed && cents > 0 ? "+" : ""
  return `${sign}$${grouped}.${rest}`
}

/** Formats a decimal USD string, or returns null when there is no amount. */
export function formatUsd(value: string | null | undefined): string | null {
  const cents = toCents(value)
  return cents === null ? null : formatCents(cents)
}

/** Formats a percent string from the API ("6.00") as "6.00%". The server computes it. */
export function formatPct(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return /^-?\d+(\.\d+)?$/.test(value.trim()) ? `${value.trim()}%` : null
}
