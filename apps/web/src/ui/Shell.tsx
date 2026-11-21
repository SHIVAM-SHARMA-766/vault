// The frame every signed-in screen shares: brand, a slot for the screen's own
// controls, and the account menu (vault, settings, admin, lock). Screens pass
// their content; nothing else redraws the top bar.

import { useEffect, useRef, useState, type ReactNode } from 'react'

import * as session from '../lib/session.js'
import { Link, navigate, useRoute } from '../lib/router.js'
import { useScopes } from '../lib/workspace.js'
import { IconGrid, IconKey, IconLock, IconHelp, IconSwap, IconUser, IconUsers } from './icons.js'
import { BrandMark, useEdition } from '../lib/instance.js'
import { NotificationBell } from './Notifications.js'
import { t } from '../lib/i18n.js'

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', support: 'Support', marketing: 'Marketing', viewer: 'Viewer' }

export function Shell({ state, tag, center, actions, children }: {
  state: session.Unlocked
  /** A small label beside the brand, e.g. the admin role. */
  tag?: string
  center?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/app/" className="brand" title="Your vault">
          <BrandMark size={18} />
          {tag ? <span className="admin-tag">{tag}</span> : null}
        </Link>
        <WorkspaceSwitch state={state} />
        {center}
        <div className="topbar-actions">
          {actions}
          <NotificationBell />
          <AccountMenu state={state} />
          <button className="btn btn-ghost" onClick={session.lock} title={t('Lock vault')} aria-label={t('Lock vault')}>
            <IconLock size={16} /><span className="hide-sm">{t('Lock')}</span>
          </button>
        </div>
      </header>
      {children}
    </div>
  )
}

/** "My vault" and "Admin console" (decisions/0031), for whoever administers
 *  something: the server, or an organization as its owner or admin. Everyone
 *  else never sees the console at all. */
function WorkspaceSwitch({ state }: { state: session.Unlocked }) {
  const { scopes } = useScopes(state)
  const { features } = useEdition()
  const route = useRoute()
  if (!scopes.length) return null
  const inConsole = route.name === 'console'
  return (
    <nav className="workspace-switch" aria-label="Workspace">
      <Link to="/app/" className={inConsole ? '' : 'is-active'} aria-current={inConsole ? undefined : 'page'}><IconKey size={14} /><span>{t('My vault')}</span></Link>
      <Link to="/app/console" className={inConsole ? 'is-active' : ''} aria-current={inConsole ? 'page' : undefined}><IconGrid size={14} /><span>{features.invitations ? t('Admin console') : t('Server settings')}</span></Link>
    </nav>
  )
}

function AccountMenu({ state }: { state: session.Unlocked }) {
  const [open, setOpen] = useState(false)
  const { features } = useEdition()
  const { scopes } = useScopes(state)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const go = (to: string) => { setOpen(false); navigate(to) }
  const role = state.role && state.role !== 'user' ? ROLE_LABEL[state.role] : null

  return (
    <div className="menu" ref={ref}>
      <button className="account account-button" aria-haspopup="menu" aria-expanded={open}
              aria-label={t('Account menu')} onClick={() => setOpen(!open)}>
        <span className="account-avatar">{state.email[0]?.toUpperCase()}</span>
        <span className="account-email hide-md">{state.email}</span>
      </button>
      {open ? (
        <div className="menu-pop" role="menu">
          <div className="menu-head">
            <span className="menu-email">{state.email}</span>
            {role ? <span className="pill pill-accent">{role}</span> : null}
          </div>
          <button role="menuitem" className="menu-item" onClick={() => go('/app/')}><IconKey size={15} />{t('Vault')}</button>
          <button role="menuitem" className="menu-item" onClick={() => go('/app/settings')}><IconUser size={15} />Account settings</button>
          {features.organizations ? <button role="menuitem" className="menu-item" onClick={() => go('/app/orgs')}><IconUsers size={15} />{t('My organizations')}</button> : null}
          <button role="menuitem" className="menu-item" onClick={() => go('/app/import-export')}><IconSwap size={15} />Import &amp; export</button>
          {features.serviceDesk ? <button role="menuitem" className="menu-item" onClick={() => go('/app/support')}><IconHelp size={15} />Help &amp; support</button> : null}
          {scopes.length ? (
            <button role="menuitem" className="menu-item" onClick={() => go('/app/console')}><IconGrid size={15} />{features.invitations ? t('Admin console') : t('Server settings')}</button>
          ) : null}
          <div className="menu-sep" />
          <button role="menuitem" className="menu-item" onClick={session.lock}><IconLock size={15} />Lock now</button>
        </div>
      ) : null}
    </div>
  )
}
