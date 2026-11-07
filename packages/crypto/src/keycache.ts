// Imported AES keys, cached per key buffer.
//
// Unlocking a vault decrypts every entry under the same vault key; importing
// that key into Web Crypto once per entry made a 5,000-item unlock spend most
// of its time in importKey. The CryptoKey is cached against the Uint8Array it
// came from (a WeakMap, so it goes when the buffer does), and it is dropped
// when the buffer is wiped (encoding.ts), so wiping a key still means it can
// no longer be used. A cached entry also remembers a cheap fingerprint of the
// bytes, so a buffer reused with different contents is re-imported.

const cache = new WeakMap<Uint8Array, { sum: number; key: CryptoKey }>()

const fingerprint = (bytes: Uint8Array): number => {
  let h = 2166136261
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 16777619)
  return h >>> 0
}

export async function cachedAesKey(raw: Uint8Array, importer: (raw: Uint8Array) => Promise<CryptoKey>): Promise<CryptoKey> {
  const sum = fingerprint(raw)
  const hit = cache.get(raw)
  if (hit && hit.sum === sum) return hit.key
  const key = await importer(raw)
  cache.set(raw, { sum, key })
  return key
}

export function forgetKey(raw: Uint8Array): void {
  cache.delete(raw)
}
