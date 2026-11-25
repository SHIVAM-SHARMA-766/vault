import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.js'
import { applyStoredTheme } from './lib/prefs.js'
import './styles.css'

applyStoredTheme()

const root = document.getElementById('root')
if (!root) throw new Error('no #root element')

// Web Crypto and passkeys exist only on a secure origin (https, or localhost).
// Over plain http the vault could not open, so say why instead of failing
// halfway through a sign-in (docs/no-domain.md).
function Insecure() {
  return (
    <main className="auth-main auth-insecure">
      <div className="auth-card" role="alert">
        <h1 className="auth-title">This browser cannot run Vault here</h1>
        <p className="auth-sub">Vault encrypts your passwords in this page, and browsers allow that only over <strong>https://</strong>. This address is not secure:</p>
        <p><code>{location.origin}</code></p>
        <p className="auth-sub">If you run this server, put HTTPS in front of it. A free name and certificate work: see &ldquo;Running Vault without buying a domain&rdquo; in the install guide.</p>
      </div>
    </main>
  )
}

createRoot(root).render(
  <StrictMode>
    {window.isSecureContext && globalThis.crypto?.subtle ? <App /> : <Insecure />}
  </StrictMode>,
)
