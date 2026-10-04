// Halo follows the OS light/dark preference. Web pages follow it too (main/page-theme.js).
type ThemeWindow = {
  matchMedia?: (query: string) => {
    matches: boolean
    addEventListener?: (type: 'change', listener: () => void) => void
    removeEventListener?: (type: 'change', listener: () => void) => void
  }
  document: { documentElement: { dataset: Record<string, string | undefined> } }
}

const LIGHT = '(prefers-color-scheme: light)'

export function applyTheme(win: ThemeWindow = window as unknown as ThemeWindow): void {
  const light = win.matchMedia?.(LIGHT).matches === true
  win.document.documentElement.dataset.theme = light ? 'light' : 'dark'
}

export function watchSystemTheme(win: ThemeWindow = window as unknown as ThemeWindow): () => void {
  applyTheme(win)
  const mq = win.matchMedia?.(LIGHT)
  if (!mq?.addEventListener) return () => {}
  const onChange = () => applyTheme(win)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener?.('change', onChange)
}
