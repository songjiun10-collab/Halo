/** Resolve a typed address or ordinary search text into an HTTP(S) destination. */
export function addressTarget(value: string): string | null {
  const input = value.trim()
  if (!input) return null
  if (input.startsWith('//')) return `https:${input}`
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) return input
  // Match the main-process address bar behavior: explicit web hosts navigate,
  // while bare words/phrases go to search instead of failing as DNS names.
  if (input === 'localhost' || input.startsWith('localhost:') || input.startsWith('localhost/')) {
    return `https://${input}`
  }
  if (/\s/.test(input) || !input.includes('.')) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(input)}`
  }
  return `https://${input}`
}
