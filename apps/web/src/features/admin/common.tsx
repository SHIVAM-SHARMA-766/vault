// Pieces every admin tab shares: loading, the section frame, dates, and
// running an action with a toast.

import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { Link } from '../../lib/router.js'
import * as session from '../../lib/session.js'
import { IconAlert } from '../../ui/icons.js'
import type { useToast } from '../../ui/kit.js'
import { when as fmtWhen } from '../../lib/format.js'

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
            <li><Link to="/app/">Vault</Link></li>
            <li>Admin</li>
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

