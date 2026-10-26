import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/orbitron/500.css'
import '@fontsource/vt323/400.css'
import '@fontsource/space-mono/400.css'
import '@fontsource/space-mono/700.css'
import '@fontsource/share-tech-mono/400.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import './themes.css'
import { App } from './App'
import { applyTheme, useStore } from './store'

applyTheme(useStore.getState().theme)

// A file dropped outside a terminal would otherwise navigate the window to it.
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
