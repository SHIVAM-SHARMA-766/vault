// Pieces every admin tab shares: loading, the section frame, dates, and
// running an action with a toast.

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { Link } from '../../lib/router.js'
import * as session from '../../lib/session.js'
import { IconAlert } from '../../ui/icons.js'
import type { useToast } from '../../ui/kit.js'
import { when as fmtWhen } from '../../lib/format.js'
import type { Role } from '../../lib/api.js'

export function useAdminData<T>(load: (token: string) => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    setError('')
    try {
      setData(await load(await session.token()))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load.')
    }
  }, [load])
  useEffect(() => { void reload() }, [reload])
  return { data, error, reload }
}

export function Section({ title, sub, actions, children }: { title: string; sub?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="admin-section">
      <div className="admin-head">
        <div>
          <ol className="crumbs crumbs-admin" aria-label="Breadcrumb">
            <li><Link to="/app/console">Admin console</Link></li>
            <li><Link to="/app/console/server">Server</Link></li>
            <li aria-current="page">{title}</li>
          </ol>
          <h1>{title}</h1>
          {sub ? <p className="muted">{sub}</p> : null}
        </div>
        {actions ? <div className="admin-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** A friendly empty list: what would be here, and what to do about it. */
export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty admin-empty">
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ?? null}
    </div>
  )
}

export function ErrorBox({ error }: { error: string }) {
  return error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null
}

export function when(iso: string | null | undefined): string {
  return fmtWhen(iso)
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

export async function run(toast: ReturnType<typeof useToast>, action: (token: string) => Promise<unknown>, done: string) {
  try {
    await action(await session.token())
    toast(done)
    return true
  } catch (err) {
    toast(err instanceof Error ? err.message : 'That did not work.', 'error')
    return false
  }
}


export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner', admin: 'Admin', support: 'Support', marketing: 'Marketing', viewer: 'Viewer', user: 'User',
}
export const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including roles. Set in the host configuration.',
  admin: 'Users, invitations, registration and the website. Cannot change roles.',
  support: 'The service desk and invitations. Escalates account changes to an admin.',
  marketing: 'The website only: text, search details, images and the banner.',
  viewer: 'Can see everything in this panel and change nothing.',
  user: 'No admin access.',
}

