// The top of the client: the sign-in screens while locked, and the routed
// screens once unlocked. Routing lives in lib/router.tsx; every screen draws
// its own content inside ui/Shell.tsx.

import { useEffect, useState } from 'react'

import { api } from './lib/api.js'
import { newIdentity } from './lib/identity.js'
import { useRoute } from './lib/router.js'
import * as session from './lib/session.js'
import { IconArrowLeft, IconLock, IconShield } from './ui/icons.js'
import { ToastProvider } from './ui/kit.js'
import { Recover } from './features/auth/Recover.js'
import { Register } from './features/auth/Register.js'
import { Unlock } from './features/auth/Unlock.js'
import { Admin } from './features/admin/Admin.js'
import { Settings } from './features/settings/Settings.js'
import { Transfer } from './features/transfer/Transfer.js'
import { Vault } from './features/vault/Vault.js'

type AuthView = 'unlock' | 'register' | 'recover'

export function App() {
  const [unlocked, setUnlocked] = useState(session.get())
  useEffect(() => session.subscribe(setUnlocked), [])

  return (
    <ToastProvider>
      {unlocked ? <Signed state={unlocked} /> : <AuthScreen />}
    </ToastProvider>
  )
}

/** Once per unlock: learn the account's id and role, and enrol an identity
 *  key on accounts from before identity keys existed (decisions/0009). */
function useAccount(state: session.Unlocked) {
  // The vault key is a new object on every unlock, so this runs once per unlock.
  useEffect(() => {
    void (async () => {
      try {
        const me = await api.me(await session.token())
        session.patch({ userId: me.userId, isAdmin: me.isAdmin, role: me.role, permissions: me.permissions })
        if (!me.identity) {
          try {
            await api.setIdentity(await session.token(), await newIdentity(state.vaultKey))
          } catch { /* tried again on the next unlock */ }
        }
      } catch { /* the vault still works; staff screens just stay hidden */ }
    })()
  }, [state.vaultKey])
}

function Signed({ state }: { state: session.Unlocked }) {
  useAccount(state)
  const route = useRoute()
  if (route.name === 'settings') return <Settings state={state} />
  if (route.name === 'transfer') return <Transfer state={state} />
  if (route.name === 'admin') {
    // The role arrives a moment after unlock; until it does, say so rather
    // than flash the vault or a refusal.
    if (state.role === undefined) return <div className="boot">Loading…</div>
    if (state.isAdmin) return <Admin state={state} tab={route.tab} />
  }
  return <Vault state={state} />
}

function AuthScreen() {
  // A first-run setup link (/app/?setup=CODE, printed in the server's log)
  // opens account creation with the code filled in.
  const [setupCode] = useState(() => new URLSearchParams(location.search).get('setup') ?? '')
  const [view, setView] = useState<AuthView>(setupCode ? 'register' : 'unlock')
  // /app/admin is the admin panel's address. Signing in there is the same
  // sign-in, but the page should say where it leads.
  const forAdmin = location.pathname.startsWith('/app/admin')
  const place = forAdmin ? 'Admin panel' : 'Vault'
  const step = view === 'unlock' ? 'Sign in' : view === 'register' ? 'Create account' : 'Recover'

  return (
    <div className="auth">
      <aside className="auth-brand">
        <a className="brand" href="/" title="Go to the Vault website"><span className="brand-mark"><IconShield size={20} /></span>Vault</a>
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
          <a className="brand brand-compact" href="/" title="Go to the Vault website"><span className="brand-mark"><IconShield size={20} /></span>Vault</a>
          <nav className="auth-nav" aria-label="Breadcrumb">
            <a className="auth-home" href="/"><IconArrowLeft size={15} />Back to website</a>
            <ol className="crumbs">
              <li><a href="/">Home</a></li>
              <li>{view !== 'unlock' ? <button type="button" className="crumb-link" onClick={() => setView('unlock')}>{place}</button> : place}</li>
              <li aria-current="page">{step}</li>
            </ol>
          </nav>
          {view === 'unlock' ? (
            <Unlock forAdmin={forAdmin} onRegister={() => setView('register')} onRecover={() => setView('recover')} />
          ) : view === 'register' ? (
            <Register setupCode={setupCode} onCancel={() => setView('unlock')}
                      onDone={() => { if (setupCode) history.replaceState(null, '', '/app/'); setView('unlock') }} />
          ) : (
            <Recover onCancel={() => setView('unlock')} />
          )}
        </div>
      </main>
    </div>
  )
}
