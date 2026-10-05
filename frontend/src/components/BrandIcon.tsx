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

const LOCAL: Brand = { bg: '#3b3f46', glyph: <g fill="none" stroke="currentColor" strokeWidth="2"><rect x="3.5" y="5" width="17" height="11" rx="2" /><path d="M8 20h8M12 16v4" /></g> }

export function brandFor(host: string): Brand | null {
  const h = host.replace(/^www\./, '').toLowerCase()
  const hit = Object.keys(BRANDS).find((d) => h === d || h.endsWith(`.${d}`))
  if (hit) return BRANDS[hit]
  if (h === 'localhost' || h.endsWith('.localhost') || /^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return LOCAL
  return null
}

export function BrandIcon({ host, size = 28 }: { host: string; size?: number }) {
  const brand = brandFor(host)
  if (!brand) return null
  return <span className="hx-brand" aria-hidden="true" style={{ width: size, height: size, background: brand.bg, color: brand.fg ?? '#fff' }}>
    <svg viewBox="0 0 24 24" width={size * 0.64} height={size * 0.64} focusable="false">{brand.glyph}</svg>
  </span>
}

/** Provider marks for Settings; keyed by planner provider id. */
const fill = (d: string) => <path fill="currentColor" d={d} />

const PROVIDERS: Record<string, Brand> = {
  claude_code: { bg: '#d97757', glyph: fill("m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z") },
  // No OpenAI mark ships in simple-icons; Codex is shown as its terminal prompt on OpenAI green.
  codex_cli: { bg: '#10a37f', glyph: <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5.5 7.5 5 4.5-5 4.5" /><path d="M13 17h5.5" /></g> },
  // Antigravity has no published glyph here; a peak lifting off a baseline on Google blue.
  antigravity: { bg: '#4285f4', glyph: <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 17 7-11 7 11" /><path d="M8.5 20.5h7" /></g> },
  cursor: { bg: '#14120b', glyph: fill("M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23") },
  nvidia: { bg: '#000', fg: '#76b900', glyph: fill("M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z") },
  opencode_cli: { bg: '#211e1e', glyph: <path fill="currentColor" fillRule="evenodd" d="M17 4.8H7v14.4h10zM22 24H2V0h20z" transform="translate(0 0)" /> },
}

export function ProviderIcon({ id, size = 28 }: { id: string; size?: number }) {
  const brand = PROVIDERS[id]
  if (!brand) return null
  return <span className="hx-brand" aria-hidden="true" style={{ width: size, height: size, background: brand.bg, color: brand.fg ?? '#fff' }}>
    <svg viewBox="0 0 24 24" width={size * 0.64} height={size * 0.64} focusable="false">{brand.glyph}</svg>
  </span>
}
