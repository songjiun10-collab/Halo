/** Reject blank submissions without normalizing the user's recorded text. */
export function nonEmptyVerbatim(value: string): string | null {
  return value.trim() ? value : null
}
