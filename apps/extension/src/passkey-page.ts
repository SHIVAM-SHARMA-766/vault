// Passkeys in Vault (decisions/0035): this runs in the page's own world, so
// that the site's navigator.credentials.create() and get() reach Vault first.
// It holds nothing and decides nothing. It passes the request to Vault's
// isolated script and, through it, to the background, which checks the
// site's origin as the browser reports it. Anything Vault does not take, or
// the person sends elsewhere, goes to the browser exactly as before.
//
// Registered at run time only when the person turns on "Save and use passkeys
// in Vault" (world: MAIN, document_start, top frame).

(() => {
  const creds = navigator.credentials
  if (!creds) return
  const original = { create: creds.create.bind(creds), get: creds.get.bind(creds) }

  const toB64u = (src: BufferSource): string => {
    const b = src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    let s = ''
    for (const x of b) s += String.fromCharCode(x)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const toBuf = (s: string): ArrayBuffer => {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer
  }

  let seq = 0
  /** Asks Vault through the isolated script; null means "the browser's turn". */
  function ask(kind: 'create' | 'get', options: unknown, signal?: AbortSignal | null): Promise<Record<string, unknown> | null> {
    const id = `${Date.now()}-${++seq}-${Math.random().toString(36).slice(2)}`
    return new Promise((resolve, reject) => {
      const done = () => { removeEventListener('message', onReply); signal?.removeEventListener('abort', onAbort) }
      const onReply = (e: MessageEvent) => {
        const d = e.data as { __vaultPasskeyReply?: string; result?: Record<string, unknown>; fallback?: boolean; error?: { name: string; message: string } } | null
        if (e.source !== window || d?.__vaultPasskeyReply !== id) return
        done()
        if (d.error) reject(new DOMException(d.error.message, d.error.name))
        else resolve(d.fallback ? null : d.result ?? null)
      }
      const onAbort = () => { done(); postMessage({ __vaultPasskeyCancel: id }, location.origin); reject(new DOMException('The operation was aborted.', 'AbortError')) }
      if (signal?.aborted) { reject(new DOMException('The operation was aborted.', 'AbortError')); return }
      addEventListener('message', onReply)
      signal?.addEventListener('abort', onAbort)
      postMessage({ __vaultPasskey: id, kind, options }, location.origin)
    })
  }

  const define = <T extends object>(target: T, props: Record<string, unknown>): T => {
    for (const [k, v] of Object.entries(props)) Object.defineProperty(target, k, { value: v, enumerable: true, configurable: true })
    return target
  }

  /** An object a site treats as a PublicKeyCredential: the real prototypes,
   *  with own properties standing in for the native getters. */
  function credential(r: Record<string, string | string[] | number>, kind: 'create' | 'get'): PublicKeyCredential {
    const rawId = toBuf(r['id'] as string)
    const clientDataJSON = toBuf(r['clientDataJSON'] as string)
    const authenticatorData = toBuf(r['authenticatorData'] as string)
    let response: AuthenticatorResponse
    let json: Record<string, unknown>
    if (kind === 'create') {
      response = define(Object.create(AuthenticatorAttestationResponse.prototype), {
        clientDataJSON, attestationObject: toBuf(r['attestationObject'] as string),
        getTransports: () => [...(r['transports'] as string[])], getAuthenticatorData: () => authenticatorData,
        getPublicKey: () => toBuf(r['publicKey'] as string), getPublicKeyAlgorithm: () => -7,
      })
      json = { clientDataJSON: r['clientDataJSON'], attestationObject: r['attestationObject'], authenticatorData: r['authenticatorData'], transports: r['transports'], publicKey: r['publicKey'], publicKeyAlgorithm: -7 }
    } else {
      response = define(Object.create(AuthenticatorAssertionResponse.prototype), {
        clientDataJSON, authenticatorData, signature: toBuf(r['signature'] as string), userHandle: toBuf(r['userHandle'] as string),
      })
      json = { clientDataJSON: r['clientDataJSON'], authenticatorData: r['authenticatorData'], signature: r['signature'], userHandle: r['userHandle'] }
    }
    const ext = kind === 'create' ? { credProps: { rk: true } } : {}
    return define(Object.create(PublicKeyCredential.prototype), {
      id: r['id'], rawId, type: 'public-key', response, authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ext,
      toJSON: () => ({ id: r['id'], rawId: r['id'], type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: ext, response: json }),
    })
  }

  creds.create = async function create(options?: CredentialCreationOptions): Promise<Credential | null> {
    const pk = options?.publicKey
    if (!pk) return original.create(options)
    const plain = {
      rp: { id: pk.rp.id, name: pk.rp.name }, user: { id: toB64u(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
      challenge: toB64u(pk.challenge), algs: pk.pubKeyCredParams.map((p) => p.alg),
      exclude: (pk.excludeCredentials ?? []).map((c) => toB64u(c.id)),
      attachment: pk.authenticatorSelection?.authenticatorAttachment ?? null,
    }
    const r = await ask('create', plain, options?.signal)
    return r ? credential(r as Record<string, string>, 'create') : original.create(options)
  }

  creds.get = async function get(options?: CredentialRequestOptions): Promise<Credential | null> {
    const pk = options?.publicKey
    // The autofill flavour (conditional mediation) stays with the browser.
    if (!pk || options?.mediation === 'conditional') return original.get(options)
    const plain = { rpId: pk.rpId ?? null, challenge: toB64u(pk.challenge), allow: (pk.allowCredentials ?? []).map((c) => toB64u(c.id)) }
    const r = await ask('get', plain, options?.signal)
    return r ? credential(r as Record<string, string>, 'get') : original.get(options)
  }

})()

export {}
