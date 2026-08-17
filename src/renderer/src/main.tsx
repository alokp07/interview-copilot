import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Opening the Vite URL in a browser has no preload bridge. Rather than crash,
// install a fake one so the interface can be designed outside Electron — the
// overlay is excluded from screen capture, so it cannot otherwise be seen.
if (import.meta.env.DEV && !window.cue) {
  const { installDevBridge } = await import('./lib/dev-bridge')
  installDevBridge()
}

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
