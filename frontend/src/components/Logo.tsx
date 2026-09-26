/** HALO mark: the ring from public/favicon.svg, plus the wordmark. */
export function Logo() {
  return (
    <span className="hx-logo">
      <svg className="hx-logo__mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" strokeWidth="3" />
      </svg>
      <span className="hx-logo__word">HALO</span>
    </span>
  )
}
