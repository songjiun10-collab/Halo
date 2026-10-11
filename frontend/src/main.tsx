import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import './styles/design-system.css'
import App from './App'
import { watchSystemTheme } from './session/theme'

watchSystemTheme()
if (/Mac/.test(navigator.userAgent)) document.documentElement.dataset.platform = 'darwin'
// Chromium now has native window glass; the runtime flag keeps the page backdrop and glass tuning specific to it.
if (window.haloBrowser?.runtime === 'chromium') document.documentElement.dataset.runtime = 'chromium'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
