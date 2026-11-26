// Unlock with a passkey (decisions/0034). The passkey's PRF output, which the
// authenticator computes after verifying its user, wraps the vault key in
// this browser. The server keeps the wrapped copy and checks the passkey's
// signature; it never sees the PRF output.

import { PASSKEY_PRF_SALT, randomBytes, toBase64Url, unwrapWithPasskey, wipe, wrapForPasskey } from '@vault/crypto'

import { api } from './api.js'
import * as session from './session.js'
import { createWithExtensions, getWithExtensions, webauthnSupported } from './webauthn.js'

const prfRequest = () => ({ prf: { eval: { first: PASSKEY_PRF_SALT } } })

export class NoPrfError extends Error {
  constructor() {
    super('This passkey cannot unlock a vault: its device or browser does not offer the PRF extension. Try a passkey on another device or a recent security key, and remove the one just made from this device\'s passkey list.')
    this.name = 'NoPrfError'
  }
}

/** Whether to offer passkeys at all. Browsers that can say up front that
 *  they lack PRF are believed; the others are tried. */
export async function passkeysOffered(): Promise<boolean> {
  if (!webauthnSupported()) return false
  try {
    const caps = await (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities?.()
    if (caps && caps['extension:prf'] === false) return false
  } catch { /* unknown: offer it */ }
  return true
}

/** Makes a passkey for this account, gets its PRF output (from the creation
 *  if the authenticator gives it then, or from one more touch), wraps the
 *  vault key with it, checks the wrapping opens, and saves it. */
export async function enrolPasskey(state: session.Unlocked, authKey: string, name: string): Promise<{ id: string; name: string }> {
  const { options } = await api.passkeys.options(await session.token(), authKey)
  const o = options as { rp: { id?: string }; user: Record<string, unknown> }
  // The device's passkey list shows this; the server does not know the address.
  o.user = { ...o.user, name: state.email, displayName: state.email }
  const made = await createWithExtensions(options, prfRequest())
  const id = String(made.response['id'])
  let out = made.prf.first
  if (!out) {
    if (made.prf.enabled === false) throw new NoPrfError()
    // Many authenticators say "enabled" at creation and answer only on use.
    // The challenge is local: this assertion is never sent to the server.
    const used = await getWithExtensions({
      challenge: toBase64Url(randomBytes(32)), ...(o.rp.id ? { rpId: o.rp.id } : {}), userVerification: 'required', allowCredentials: [{ id, type: 'public-key' }],
    }, prfRequest())
    out = used.prf.first
  }
  if (!out) throw new NoPrfError()
  try {
    const wrapping = await wrapForPasskey(state.vaultKey, state.email, out, id)
    wipe((await unwrapWithPasskey(wrapping, out, id)).vaultKey)
    return await api.passkeys.add(await session.token(), name, made.response, wrapping)
  } finally { wipe(out) }
}

/** Signs in with whichever Vault passkey the person picks, and opens the vault. */
export async function signInWithPasskey(ssoTicket?: string): Promise<void> {
  const { options } = await api.passkeyLogin.options()
  const got = await getWithExtensions(options, prfRequest())
  const out = got.prf.first
  if (!out) throw new NoPrfError()
  try {
    const r = await api.passkeyLogin.finish(got.response, ssoTicket)
    const { vaultKey, email } = await unwrapWithPasskey(r, out, r.credentialId)
    session.unlock({
      userId: '', email, vaultKey,
      accessToken: r.accessToken, refreshToken: r.refreshToken, kdf: r.kdf,
      accessExpiresAt: session.expiresAtFrom(r),
    })
  } finally { wipe(out) }
}
