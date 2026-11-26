// navigator.credentials, in JSON (decisions/0022): the server's options come
// as JSON with base64url strings; the browser wants ArrayBuffers, and its
// answer is turned back into JSON for the server.

const toBuf = (s: string): ArrayBuffer => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}
const toB64u = (b: ArrayBuffer | null): string | undefined => {
  if (!b) return undefined
  let s = ''
  for (const byte of new Uint8Array(b)) s += String.fromCharCode(byte)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface Desc { id: string; type?: string; transports?: string[] }

export const webauthnSupported = () => typeof window.PublicKeyCredential === 'function'

/** The PRF extension's output, taken out of the extension results so that it
 *  is never sent anywhere: the answer goes to the server, this stays here. */
export type Prf = { enabled?: boolean; first?: Uint8Array }
function takePrf(cred: PublicKeyCredential): { results: Record<string, unknown>; prf: Prf } {
  const { prf, ...results } = cred.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } }
  const first = prf?.results?.first
  return { results, prf: { ...(prf?.enabled !== undefined ? { enabled: prf.enabled } : {}), ...(first ? { first: new Uint8Array(first) } : {}) } }
}
type Extensions = Record<string, unknown>

export async function createCredential(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await createWithExtensions(options)).response
}

export async function createWithExtensions(options: Record<string, unknown>, extensions?: Extensions): Promise<{ response: Record<string, unknown>; prf: Prf }> {
  const o = options as { challenge: string; user: { id: string; name: string; displayName: string }; excludeCredentials?: Desc[] } & Record<string, unknown>
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...(o as unknown as PublicKeyCredentialCreationOptions),
      challenge: toBuf(o.challenge),
      user: { ...o.user, id: toBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ id: toBuf(c.id), type: 'public-key' as const, ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}) })),
      ...(extensions ? { extensions: extensions as AuthenticationExtensionsClientInputs } : {}),
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('No key was added.')
  const r = cred.response as AuthenticatorAttestationResponse
  const { results, prf } = takePrf(cred)
  return {
    prf,
    response: {
      id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, clientExtensionResults: results,
      response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: r.getTransports?.() ?? [] },
    },
  }
}

export async function getAssertion(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await getWithExtensions(options)).response
}

export async function getWithExtensions(options: Record<string, unknown>, extensions?: Extensions): Promise<{ response: Record<string, unknown>; prf: Prf }> {
  const o = options as { challenge: string; allowCredentials?: Desc[] } & Record<string, unknown>
  const cred = (await navigator.credentials.get({
    publicKey: {
      ...(o as unknown as PublicKeyCredentialRequestOptions),
      challenge: toBuf(o.challenge),
      allowCredentials: (o.allowCredentials ?? []).map((c) => ({ id: toBuf(c.id), type: 'public-key' as const, ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}) })),
      ...(extensions ? { extensions: extensions as AuthenticationExtensionsClientInputs } : {}),
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('No key answered.')
  const r = cred.response as AuthenticatorAssertionResponse
  const { results, prf } = takePrf(cred)
  return {
    prf,
    response: {
      id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, clientExtensionResults: results,
      response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: toB64u(r.userHandle) },
    },
  }
}
