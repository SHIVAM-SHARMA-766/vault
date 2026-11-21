// Signed key grants in the web app (decisions/0025): the trust store kept on
// the server, around the checks in grants.ts that every client shares.

import { type OrgMember, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { type TrustStore, checkGrant, fingerprintOf, openTrust, sealTrust, trustedSigners as signersFrom } from './grants.js'

export { type TrustStore, checkGrant, fingerprintOf }

export async function loadTrust(orgId: string, vaultKey: Uint8Array): Promise<TrustStore> {
  try { return await openTrust(orgId, vaultKey, (await api.orgs.getTrust(await session.token(), orgId)).blob) } catch { return {} }
}

export async function saveTrust(orgId: string, vaultKey: Uint8Array, t: TrustStore): Promise<void> {
  await api.orgs.putTrust(await session.token(), orgId, await sealTrust(orgId, vaultKey, t)).catch(() => {})
}

/** Who may sign grants here, as this account trusts them (grants.ts). */
export function trustedSigners(orgId: string, members: OrgMember[], trust: TrustStore, vaultKey: Uint8Array) {
  return signersFrom(orgId, members, trust, (t) => saveTrust(orgId, vaultKey, t))
}
