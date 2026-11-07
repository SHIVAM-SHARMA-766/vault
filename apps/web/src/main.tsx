import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.js'
import { applyStoredTheme } from './lib/prefs.js'
import './styles.css'

applyStoredTheme()

const root = document.getElementById('root')
if (!root) throw new Error('no #root element')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
