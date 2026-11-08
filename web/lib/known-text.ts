/** Placeholder text the API uses when it could not name the company or period. */
export function knownText(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text && !/^unknown\b/i.test(text) ? text : null
}
