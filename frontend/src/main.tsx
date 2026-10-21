import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import './styles/design-system.css'
import './styles/chromium.css'
import App from './App'
// Halo for Chromium is a light chrome; web pages still follow the OS theme (main/page-theme.js).
document.documentElement.dataset.theme = 'light'
if (/Mac/.test(navigator.userAgent)) document.documentElement.dataset.platform = 'darwin'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
