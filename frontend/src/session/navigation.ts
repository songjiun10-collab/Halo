/** Normalize a typed web address without turning it into a search or command. */
export function addressTarget(value: string): string | null {
  const input = value.trim()
  if (!input) return null
  if (input.startsWith('//')) return `https:${input}`
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) return input
  return `https://${input}`
}
