import type { ReactNode } from 'react'

/** Inline marks for well-known sites; the page CSP blocks remote favicons, so these ship with the app. */
interface Brand { bg: string; fg?: string; glyph: ReactNode }

const text = (t: string) => <text x="12" y="17" textAnchor="middle" fontSize="15" fontWeight="800" fill="currentColor" fontFamily="system-ui, sans-serif">{t}</text>

const BRANDS: Record<string, Brand> = {
  'github.com': { bg: '#24292f', glyph: <path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.200a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.200v3.300c0 .3.2.7.8.6A12 12 0 0 0 12 .3" /> },
  'instagram.com': { bg: 'linear-gradient(45deg,#f9a233,#e1306c 55%,#5b51d8)', glyph: <g fill="none" stroke="currentColor" strokeWidth="2"><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17" cy="7" r=".6" fill="currentColor" /></g> },
  'youtube.com': { bg: '#ff0000', glyph: <path fill="currentColor" d="M9.5 7.500v9l7.5-4.500z" /> },
  'x.com': { bg: '#000', glyph: text('𝕏') },
  'twitter.com': { bg: '#000', glyph: text('𝕏') },
  'google.com': { bg: '#fff', fg: '#4285f4', glyph: text('G') },
  'naver.com': { bg: '#03c75a', glyph: text('N') },
  'facebook.com': { bg: '#1877f2', glyph: text('f') },
  'linkedin.com': { bg: '#0a66c2', glyph: text('in') },
  'reddit.com': { bg: '#ff4500', glyph: text('r') },
  'notion.so': { bg: '#fff', fg: '#111', glyph: text('N') },
  'chatgpt.com': { bg: '#10a37f', glyph: text('◎') },
  'claude.ai': { bg: '#d97757', glyph: text('✻') },
  'discord.com': { bg: '#5865f2', glyph: text('D') },
  'tiktok.com': { bg: '#000', glyph: text('♪') },
  'wikipedia.org': { bg: '#fff', fg: '#111', glyph: text('W') },
  'stackoverflow.com': { bg: '#f48024', glyph: text('S') },
  'spotify.com': { bg: '#1db954', glyph: text('♫') },
  'netflix.com': { bg: '#000', fg: '#e50914', glyph: text('N') },
  'twitch.tv': { bg: '#9146ff', glyph: text('T') },
  'pinterest.com': { bg: '#e60023', glyph: text('P') },
  'whatsapp.com': { bg: '#25d366', glyph: text('W') },
  'telegram.org': { bg: '#26a5e4', glyph: text('➤') },
  'slack.com': { bg: '#4a154b', glyph: text('#') },
  'figma.com': { bg: '#1e1e1e', glyph: text('F') },
  'apple.com': { bg: '#000', glyph: text('') },
  'microsoft.com': { bg: '#f3f3f3', fg: '#00a4ef', glyph: text('⊞') },
  'daum.net': { bg: '#2d6df6', glyph: text('D') },
  'kakao.com': { bg: '#fee500', fg: '#3c1e1e', glyph: text('K') },
  'coupang.com': { bg: '#e52528', glyph: text('C') },
  'baidu.com': { bg: '#2932e1', glyph: text('B') },
  'bing.com': { bg: '#008373', glyph: text('b') },
  'duckduckgo.com': { bg: '#de5833', glyph: text('D') },
  'medium.com': { bg: '#000', glyph: text('M') },
  'huggingface.co': { bg: '#ffd21e', fg: '#111', glyph: text('🤗') },
  'openai.com': { bg: '#10a37f', glyph: text('◎') },
  'anthropic.com': { bg: '#d97757', glyph: text('A') },
  'mozilla.org': { bg: '#000', fg: '#ff7139', glyph: text('m') },
  'amazon.com': { bg: '#232f3e', fg: '#ff9900', glyph: text('a') },
}

export function brandFor(host: string): Brand | null {
  const h = host.replace(/^www\./, '').toLowerCase()
  const hit = Object.keys(BRANDS).find((d) => h === d || h.endsWith(`.${d}`))
  return hit ? BRANDS[hit] : null
}

export function BrandIcon({ host, size = 28 }: { host: string; size?: number }) {
  const brand = brandFor(host)
  if (!brand) return null
  return <span className="hx-brand" aria-hidden="true" style={{ width: size, height: size, background: brand.bg, color: brand.fg ?? '#fff' }}>
    <svg viewBox="0 0 24 24" width={size * 0.64} height={size * 0.64} focusable="false">{brand.glyph}</svg>
  </span>
}
