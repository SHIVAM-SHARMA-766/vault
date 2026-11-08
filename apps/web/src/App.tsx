// The top of the client: the sign-in screens while locked, and the routed
// screens once unlocked. Routing lives in lib/router.tsx; every screen draws
// its own content inside ui/Shell.tsx.

import { Suspense, lazy, useEffect, useState } from 'react'

import { api } from './lib/api.js'
import { newIdentity } from './lib/identity.js'
import { SupportContact, useInstance } from './lib/instance.js'
import { useRoute } from './lib/router.js'
import * as prefs from './lib/prefs.js'
import * as session from './lib/session.js'
import { IconArrowLeft, IconLock, IconShield } from './ui/icons.js'
import { ToastProvider } from './ui/kit.js'
import { Recover } from './features/auth/Recover.js'
import { Register } from './features/auth/Register.js'
import { Unlock } from './features/auth/Unlock.js'
import { PublicRequest } from './features/desk/PublicRequest.js'
import { Vault } from './features/vault/Vault.js'

// Screens most visits never open load on demand, so unlocking the vault does
// not wait for the admin panel, the website editor or import parsers.
const Admin = lazy(() => import('./features/admin/Admin.js').then((m) => ({ default: m.Admin })))
const Settings = lazy(() => import('./features/settings/Settings.js').then((m) => ({ default: m.Settings })))
const Transfer = lazy(() => import('./features/transfer/Transfer.js').then((m) => ({ default: m.Transfer })))
const Support = lazy(() => import('./features/desk/Support.js').then((m) => ({ default: m.Support })))
const Orgs = lazy(() => import('./features/orgs/Orgs.js').then((m) => ({ default: m.Orgs })))
const ShareView = lazy(() => import('./features/share/ShareView.js').then((m) => ({ default: m.ShareView })))
const Loading = () => <div className="boot">Loading…</div>

type AuthView = 'unlock' | 'register' | 'recover' | 'request-access' | 'signin-help'

export function App() {
  const [unlocked, setUnlocked] = useState(session.get())
  useEffect(() => session.subscribe((s) => { if (!s) prefs.reset(); setUnlocked(s) }), [])

  return (
    <ToastProvider>
      {/* A share link opens the same way signed in or not, and never touches the vault. */}
      {location.pathname.startsWith('/app/s/') ? <Suspense fallback={<Loading />}><ShareView /></Suspense>
        : unlocked ? <Signed state={unlocked} /> : <AuthScreen />}
    </ToastProvider>
  )
}

/** Once per unlock: learn the account's id and role, and enrol an identity
 *  key on accounts from before identity keys existed (decisions/0009). */
function useAccount(state: session.Unlocked) {
  // The vault key is a new object on every unlock, so this runs once per unlock.
  useEffect(() => {
    void prefs.load(state.vaultKey)
    void (async () => {
      try {
        const me = await api.me(await session.token())
        session.patch({ userId: me.userId, isAdmin: me.isAdmin, role: me.role, permissions: me.permissions, policyGap: me.policyGap })
        session.setServerIdleLimit(me.policy.maxIdleMinutes)
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
  if (route.name === 'settings') return <Suspense fallback={<Loading />}><Settings state={state} tab={route.tab ?? null} /></Suspense>
  if (route.name === 'transfer') return <Suspense fallback={<Loading />}><Transfer state={state} /></Suspense>
  if (route.name === 'support') return <Suspense fallback={<Loading />}><Support state={state} /></Suspense>
  if (route.name === 'orgs') return <Suspense fallback={<Loading />}><Orgs state={state} /></Suspense>
  if (route.name === 'admin') {
    // The role arrives a moment after unlock; until it does, say so rather
    // than flash the vault or a refusal.
    if (state.role === undefined) return <div className="boot">Loading…</div>
    if (state.isAdmin) return <Suspense fallback={<Loading />}><Admin state={state} tab={route.tab} /></Suspense>
  }
  return <Vault state={state} />
}

function AuthScreen() {
  // A first-run setup link (/app/?setup=CODE, printed in the server's log)
  // opens account creation with the code filled in.
  const [setupCode] = useState(() => new URLSearchParams(location.search).get('setup') ?? '')
  // An emailed invitation (/app/?invite=CODE) does the same for a new member.
  const [inviteCode] = useState(() => new URLSearchParams(location.search).get('invite') ?? '')
  const [view, setView] = useState<AuthView>(setupCode || inviteCode ? 'register' : 'unlock')
  // /app/admin is the admin panel's address. Signing in there is the same
  // sign-in, but the page should say where it leads.
  const forAdmin = location.pathname.startsWith('/app/admin')
  const place = forAdmin ? 'Admin panel' : 'Vault'
  const instance = useInstance()
  const step = view === 'unlock' ? 'Sign in' : view === 'register' ? 'Create account' : view === 'request-access' ? 'Request access' : view === 'signin-help' ? 'Help signing in' : 'Recover'

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
        <p className="auth-foot">{instance && instance.name !== 'Vault' ? `${instance.name} · ` : ''}Zero-knowledge by design</p>
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
            <Unlock forAdmin={forAdmin} onRegister={() => setView('register')} onRecover={() => setView('recover')}
                    onRequestAccess={() => setView('request-access')} onSigninHelp={() => setView('signin-help')} />
          ) : view === 'register' ? (
            <Register setupCode={setupCode} inviteCode={inviteCode} onCancel={() => setView('unlock')}
                      onDone={() => { if (setupCode || inviteCode) history.replaceState(null, '', '/app/'); setView('unlock') }} />
          ) : view === 'request-access' || view === 'signin-help' ? (
            <PublicRequest kind={view === 'request-access' ? 'access' : 'signin'} onCancel={() => setView('unlock')} />
          ) : (
            <Recover onCancel={() => setView('unlock')} />
          )}
          <SupportContact className="muted small auth-support" />
        </div>
      </main>
    </div>
  )
}
