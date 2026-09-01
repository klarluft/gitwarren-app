import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { App } from './App'
import './index.css'

/** Follow the OS appearance, and keep following it if the user switches. */
function applyColourScheme(): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const sync = (): void => {
    document.documentElement.classList.toggle('dark', media.matches)
  }
  sync()
  media.addEventListener('change', sync)
}

applyColourScheme()

const container = document.getElementById('root')
if (!container) throw new Error('Root element is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <SWRConfig
      value={{
        // Git state is read live, so coming back to the window should refresh
        // it - a branch may well have changed while you were in the terminal.
        revalidateOnFocus: true,
        revalidateOnReconnect: false,
        shouldRetryOnError: false
      }}
    >
      <App />
    </SWRConfig>
  </StrictMode>
)
