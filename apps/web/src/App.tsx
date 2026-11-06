import { useEffect, useState } from 'react'

import * as session from './session.js'
import { IconLock, IconShield } from './icons.js'
import { ToastProvider } from './ui.js'
import { Unlock } from './pages/Unlock.js'
import { Register } from './pages/Register.js'
import { Vault } from './pages/Vault.js'

type View = 'unlock' | 'register'

export function App() {
  const [unlocked, setUnlocked] = useState(session.get())
  const [view, setView] = useState<View>('unlock')

  useEffect(() => session.subscribe(setUnlocked), [])

  return (
    <ToastProvider>
      {unlocked ? (
        <Vault state={unlocked} />
      ) : (
        <div className="auth">
          <aside className="auth-brand">
            <div className="brand"><span className="brand-mark"><IconShield size={20} /></span>Vault</div>
            <div className="auth-pitch">
              <h1>Your passwords, readable only by you.</h1>
              <p>Every entry is encrypted on this device before it is sent. The server stores
                 ciphertext and holds no key that opens it.</p>
              <ul className="auth-points">
                <li><IconLock size={16} /> The master password never leaves this browser</li>
                <li><IconLock size={16} /> AES-256-GCM, with keys derived from 600,000 PBKDF2 rounds</li>
                <li><IconLock size={16} /> Names, tags and folders are encrypted too</li>
              </ul>
            </div>
            <p className="auth-foot">Zero-knowledge by design</p>
          </aside>
          <main className="auth-main">
            <div className="auth-card">
              <div className="brand brand-compact"><span className="brand-mark"><IconShield size={20} /></span>Vault</div>
              {view === 'unlock' ? (
                <Unlock onRegister={() => setView('register')} />
              ) : (
                <Register onDone={() => setView('unlock')} onCancel={() => setView('unlock')} />
              )}
            </div>
          </main>
        </div>
      )}
    </ToastProvider>
  )
}
