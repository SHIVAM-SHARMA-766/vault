// The two workspaces (decisions/0031): "My vault", everyone's, and the
// "Admin console", for whoever administers something. What someone may
// administer is their scopes: the server (staff roles) and each organization
// where they are an owner or admin. Members of an organization have no scope
// in it; they see it under My organizations.

import { useEffect, useState } from 'react'

import { api } from './api.js'
import { features } from './instance.js'
import * as session from './session.js'

export type Scope =
  | { kind: 'server' }
  | { kind: 'org'; id: string; name: string; role: string }

let cache: { userId: string; orgs: Promise<Extract<Scope, { kind: 'org' }>[]> } | null = null
const EVENT = 'vault:scopes'

/** Forget the organizations list, after one is created, joined or left. */
export function refreshScopes(): void {
  cache = null
  window.dispatchEvent(new Event(EVENT))
}

async function adminOrgs(userId: string): Promise<Extract<Scope, { kind: 'org' }>[]> {
  if (cache?.userId === userId) return cache.orgs
  const orgs = (async () => {
    if (!(await features()).organizations) return []
    const { orgs: rows } = await api.orgs.list(await session.token())
    // The hint is the name the owner typed at creation, kept in the clear for
    // invitations; the console shows the decrypted name once it has the key.
    return rows
      .filter((r) => r.status === 'confirmed' && r.role !== 'member' && r.kind !== 'direct')
      .map((r) => ({ kind: 'org' as const, id: r.id, name: r.hint || 'Organization', role: r.role }))
  })().catch(() => [])
  cache = { userId, orgs }
  return orgs
}

/** Everything this account may administer, server first. */
export function useScopes(state: session.Unlocked): { scopes: Scope[]; loaded: boolean } {
  const [orgs, setOrgs] = useState<Extract<Scope, { kind: 'org' }>[] | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void adminOrgs(state.userId || state.email).then((o) => { if (live) setOrgs(o) })
    load()
    window.addEventListener(EVENT, load)
    return () => { live = false; window.removeEventListener(EVENT, load) }
  }, [state.userId, state.email])
  const server: Scope[] = state.isAdmin ? [{ kind: 'server' }] : []
  return { scopes: [...server, ...(orgs ?? [])], loaded: orgs !== null && state.role !== undefined }
}
