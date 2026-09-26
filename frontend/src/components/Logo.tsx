/** HALO mark: the ring from public/favicon.svg. */
export function HaloMark({ className = 'hx-logo__mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" strokeWidth="3" />
    </svg>
  )
}

export function Logo() {
  return (
    <span className="hx-logo">
      <HaloMark />
      <span className="hx-logo__word">HALO</span>
    </span>
  )
}
