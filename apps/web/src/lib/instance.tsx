// The server's public profile — its name and support contact — read once per
// page load (GET /api/instance) and shared by every screen that shows it.

import { useEffect, useState } from 'react'

import { type Instance, api } from './api.js'

let cached: Promise<Instance | null> | null = null

function fetchOnce(): Promise<Instance | null> {
  cached ??= api.instance().catch(() => null)
  return cached
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
