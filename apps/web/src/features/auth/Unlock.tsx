// The sign-in screen (decisions/0036): the account first, then the master
// password. This browser keeps the account sign-in, so most days only the
// second step shows.

import { useEffect, useState } from 'react'

import { currentAccount, onAccountChange } from '../../lib/account.js'
import { AccountSignIn, ForgotAccountPassword, MasterUnlock } from './AccountSteps.js'
import { LegacySignIn } from './LegacySignIn.js'

export function Unlock(props: {
  onRegister: () => void; onRecover: () => void; onRequestAccess: () => void; onSigninHelp: () => void; forAdmin?: boolean
  /** Back from the identity provider (decisions/0021): its ticket and the account it named. */
  sso?: { ticket: string; email: string } | null; ssoError?: string; onSsoCancel?: () => void
}) {
  const [account, setAccount] = useState(currentAccount)
  useEffect(() => onAccountChange(() => setAccount(currentAccount())), [])
  const [screen, setScreen] = useState<'account' | 'legacy' | 'forgot'>('account')
  const forAdmin = props.forAdmin ?? false
  const sso = props.sso ?? null

  // Signed in to the account (after single sign-on too, once its ticket did the account step).
  if (account && (!sso || account.email === sso.email)) return <MasterUnlock key={account.email} account={account} forAdmin={forAdmin} onRecover={props.onRecover} />
  if (screen === 'legacy') return <LegacySignIn {...props} onBack={() => setScreen('account')} />
  if (screen === 'forgot') return <ForgotAccountPassword onBack={() => setScreen('account')} />
  return (
    <AccountSignIn forAdmin={forAdmin} sso={sso} ssoError={props.ssoError ?? ''} {...(props.onSsoCancel ? { onSsoCancel: props.onSsoCancel } : {})}
      onLegacy={() => setScreen('legacy')} onForgot={() => setScreen('forgot')} onRegister={props.onRegister}
      onRecover={props.onRecover} onRequestAccess={props.onRequestAccess} onSigninHelp={props.onSigninHelp} />
  )
}
