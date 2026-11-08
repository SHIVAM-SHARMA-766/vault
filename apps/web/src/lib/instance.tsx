// The server's public profile — its name and support contact — read once per
// page load (GET /api/instance) and shared by every screen that shows it.

import { useEffect, useState } from 'react'

import { type Instance, api } from './api.js'
import { IconShield } from '../ui/icons.js'

let cached: Promise<Instance | null> | null = null

function fetchOnce(): Promise<Instance | null> {
  cached ??= api.instance().then((i) => { applyBranding(i); return i }, () => null)
  return cached
}

/** The admin's accent colour (B3), as a data attribute the stylesheet reads. */
export function applyBranding(i: Pick<Instance, 'accent'> | null): void {
  if (i?.accent) document.documentElement.dataset['accent'] = i.accent
  else delete document.documentElement.dataset['accent']
}

/** The server's logo and name where the app shows its brand (B3); the shield
 *  and "Vault" when none is set. */
export function BrandMark({ size = 20 }: { size?: number }) {
  const i = useInstance()
  return (
    <>
      <span className="brand-mark">{i?.logo ? <img className="brand-logo" src={i.logo} alt="" /> : <IconShield size={size} />}</span>
      {i?.name || 'Vault'}
    </>
  )
}

/** Forget the cached profile, after an admin changes it. */
export function refresh(): void { cached = null }

export function useInstance(): Instance | null {
  const [v, setV] = useState<Instance | null>(null)
  useEffect(() => {
    let live = true
    void fetchOnce().then((i) => {
      if (!live || !i) return
      setV(i)
      if (i.name && i.name !== 'Vault') document.title = i.name
    })
    return () => { live = false }
  }, [])
  return v
}

/** "Need help? Email support@… · Help page" — nothing when no contact is set. */
export function SupportContact({ className = 'muted small' }: { className?: string }) {
  const i = useInstance()
  if (!i || (!i.supportEmail && !i.supportUrl)) return null
  return (
    <p className={`support-contact ${className}`}>
      Need help?{' '}
      {i.supportEmail ? <a href={`mailto:${i.supportEmail}`}>{i.supportEmail}</a> : null}
      {i.supportEmail && i.supportUrl ? ' · ' : null}
      {i.supportUrl ? <a href={i.supportUrl} target="_blank" rel="noopener noreferrer">Help page</a> : null}
    </p>
  )
}
