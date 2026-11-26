// The sign-in screen (decisions/0036, 0037): the account first, then the vault.
//
//   Sign in | Create account   two tabs; the sign-in tab is email, account
//                              password and Continue, nothing more
//   Other ways to sign in      a page of its own: a passkey, the master
//                              password (first sign-in since accounts), the
//                              recovery key, an invitation code, help
//   then                       a vault: unlock it with the master password, or
//                              create it (open registration, an approval) or
//                              ask for it (invitation only)
//
// This browser keeps the account sign-in, so most days only the master
// password shows.

import { useEffect, useState } from 'react'

import { currentAccount, onAccountChange } from '../../lib/account.js'
import { t } from '../../lib/i18n.js'
import { useInstanceState } from '../../lib/instance.js'
import { IconAlert, IconArrowLeft, IconHelp, IconKey, IconLock, IconTicket, IconUser } from '../../ui/icons.js'
import { AccountSignIn, ForgotAccountPassword, MasterUnlock, PasskeyOption } from './AccountSteps.js'
import { LegacySignIn } from './LegacySignIn.js'
import { AccountSignup, VaultGate } from './VaultSteps.js'

type Screen = 'signin' | 'signup' | 'other' | 'legacy' | 'forgot'

export function Unlock(props: {
  onRegister: () => void; onRecover: () => void; onRequestAccess: () => void; onSigninHelp: () => void; forAdmin?: boolean
  /** Back from the identity provider (decisions/0021): its ticket and the account it named. */
  sso?: { ticket: string; email: string } | null; ssoError?: string; onSsoCancel?: () => void
}) {
  const [account, setAccount] = useState(currentAccount)
  useEffect(() => onAccountChange(() => setAccount(currentAccount())), [])
  const [screen, setScreen] = useState<Screen>('signin')
  const { instance, settled } = useInstanceState()
  const forAdmin = props.forAdmin ?? false
  const sso = props.sso ?? null
  const mode = instance?.registration
  const invitations = instance?.features?.invitations ?? true
  const deskOn = instance?.features?.serviceDesk ?? true
  // With mail, anyone makes an account (its address checked by a code) and
  // then creates or asks for a vault (decisions/0037). Without it, the old
  // sign-up, open or with an invitation code.
  const mailSignup = !!instance?.mail && invitations && !instance.firstRun
  const canCreate = mailSignup || mode === 'open' || (mode === 'invite' && invitations)
  const createTab: (() => void) | null = !canCreate ? null : instance?.mail ? () => setScreen('signup') : props.onRegister

  // Signed in to the account (after single sign-on too, once its ticket did the account step).
  if (account && (!sso || account.email === sso.email)) {
    // An account with no vault yet (decisions/0037): create or ask for one.
    if (account.kdf === null) return <VaultGate key={account.email} account={account} />
    return <MasterUnlock key={account.email} account={{ ...account, kdf: account.kdf }} forAdmin={forAdmin} onRecover={props.onRecover} />
  }
  // The first visit: wait for the server's profile (which sign-up it offers)
  // rather than draw the form and then add tabs to it.
  if (!instance && !settled) return <div className="skeletons" aria-busy="true" aria-label="Loading">{[0, 1, 2].map((i) => <div key={i} className="skeleton" />)}</div>
  const back = () => setScreen('signin')
  if (screen === 'legacy') return <LegacySignIn {...props} onBack={() => setScreen('other')} />
  if (screen === 'forgot') return <ForgotAccountPassword onBack={back} />
  if (screen === 'other') {
    return (
      <OtherWays onBack={back} onLegacy={() => setScreen('legacy')} onRecover={props.onRecover}
        onInvite={invitations && mode !== 'closed' && mailSignup ? props.onRegister : null}
        onHelp={deskOn ? props.onSigninHelp : null}
        onRequestAccess={deskOn && !mailSignup && mode !== 'open' ? props.onRequestAccess : null} />
    )
  }

  const tabs = createTab && !sso ? (
    <div className="segmented auth-tabs" role="group" aria-label={t('Sign in or create an account')}>
      <button type="button" aria-pressed={screen === 'signin'} className={screen === 'signin' ? 'seg-active' : ''} onClick={back}>{t('Sign in')}</button>
      <button type="button" aria-pressed={screen === 'signup'} className={screen === 'signup' ? 'seg-active' : ''} onClick={createTab}>{t('Create an account')}</button>
    </div>
  ) : null

  if (screen === 'signup') return <>{tabs}<AccountSignup /></>
  return (
    <>
      {tabs}
      <AccountSignIn forAdmin={forAdmin} sso={sso} ssoError={props.ssoError ?? ''} {...(props.onSsoCancel ? { onSsoCancel: props.onSsoCancel } : {})}
        onForgot={() => setScreen('forgot')} onOther={() => setScreen('other')} onRegister={props.onRegister} />
    </>
  )
}

/** The ways to sign in that most people never need, on a page of their own. */
function OtherWays({ onBack, onLegacy, onRecover, onInvite, onHelp, onRequestAccess }: {
  onBack: () => void; onLegacy: () => void; onRecover: () => void
  onInvite: (() => void) | null; onHelp: (() => void) | null; onRequestAccess: (() => void) | null
}) {
  const [error, setError] = useState('')
  return (
    <div>
      <button type="button" className="back-link" onClick={onBack}><IconArrowLeft size={16} />{t('Back to sign in')}</button>
      <h2 className="auth-title">{t('Other ways to sign in')}</h2>
      <p className="auth-sub">{t('Choose how you want to get in.')}</p>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <div className="auth-options">
        <PasskeyOption busy={false} onError={setError} />
        <Option icon={<IconLock size={18} />} title={t('Use my master password')} hint={t('First sign-in since accounts were added')} onClick={onLegacy} />
        <Option icon={<IconKey size={18} />} title={t('Use my recovery key')} hint={t('Forgot your master password')} onClick={onRecover} />
        {onInvite ? <Option icon={<IconTicket size={18} />} title={t('I have an invitation code')} hint={t('Create your account and vault with it')} onClick={onInvite} /> : null}
        {onRequestAccess ? <Option icon={<IconUser size={18} />} title={t('Request access')} hint={t('Ask the people who run this vault for an account')} onClick={onRequestAccess} /> : null}
        {onHelp ? <Option icon={<IconHelp size={18} />} title={t('Ask for help')} hint={t('Lost your authenticator, or still can\'t sign in')} onClick={onHelp} /> : null}
      </div>
    </div>
  )
}

function Option({ icon, title, hint, onClick }: { icon: React.ReactNode; title: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" className="auth-option" onClick={onClick}>
      {icon}
      <span><strong>{title}</strong><small>{hint}</small></span>
    </button>
  )
}
