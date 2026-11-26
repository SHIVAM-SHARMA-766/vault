// Passkeys in Vault (decisions/0035), the isolated half. It carries a page's
// passkey request from passkey-page.ts to the background, and asks the person
// first, in a closed shadow root the page cannot read. Only real clicks count
// (event.isTrusted), so a page cannot answer for them.
//
// The background takes the page's origin from the browser, never from here,
// and keeps the request it validated; this script only says which one the
// person chose.

declare const __VAULT_TEST__: boolean

type Begin =
  | { fallback: true }
  | { locked: true; rpId: string }
  | { error: { name: string; message: string } }
  | { requestId: string; kind: 'create'; rpId: string; userName: string; replaces: boolean }
  | { requestId: string; kind: 'get'; rpId: string; accounts: { credentialId: string; userName: string; name: string }[] }

const send = <T>(message: Record<string, unknown>): Promise<T | undefined> =>
  chrome.runtime.sendMessage(message).then((r: { result?: T } | undefined) => r?.result).catch(() => undefined)

const host = document.createElement('vault-passkey')
const shadow = host.attachShadow({ mode: __VAULT_TEST__ ? 'open' : 'closed' })
const style = document.createElement('style')
style.textContent = `
:host { all: initial; }
* { box-sizing: border-box; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.card { position: fixed; z-index: 2147483647; top: 16px; right: 16px; width: 320px; background: #fff; color: #121620; border: 1px solid #dfe3ea; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.2); padding: 14px; }
.card strong { display: block; font-weight: 600; margin-bottom: 2px; }
.card .muted { color: #4a5263; font-size: 12px; overflow-wrap: anywhere; }
.list { margin: 10px 0 0; display: grid; gap: 4px; }
.list button { text-align: left; border: 1px solid #dfe3ea; background: transparent; color: inherit; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.list button:hover, .list button:focus-visible { background: #eef0ff; outline: none; }
.list span { display: block; color: #4a5263; font-size: 12px; }
.row { display: flex; gap: 6px; margin-top: 12px; justify-content: flex-end; }
.row button { border: 1px solid #dfe3ea; background: transparent; color: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer; }
.row .primary { background: #4f46e5; border-color: #4f46e5; color: #fff; font-weight: 600; }
@media (prefers-color-scheme: dark) {
  .card { background: #12151c; color: #e8eaf0; border-color: #262b36; }
  .card .muted, .list span { color: #b4bac7; }
  .list button, .row button { border-color: #262b36; }
  .list button:hover { background: #1d1b3a; }
}`
shadow.append(style)

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/** When the card appeared: a click in the first moments is not taken, so a
 *  page cannot time a click on its own button to land on ours. */
let shownAt = 0
const SETTLE_MS = 600

/** A button only a person can press. */
function button(label: Node | string, onPress: () => void, primary = false): HTMLButtonElement {
  const b = el('button', { type: 'button', ...(primary ? { className: 'primary' } : {}) }, label)
  b.addEventListener('click', (e) => { if (e.isTrusted && performance.now() - shownAt > SETTLE_MS) onPress() })
  return b
}

let card: HTMLElement | null = null
let current: string | null = null
const close = () => { card?.remove(); card = null; current = null }

function show(...children: Node[]) {
  card?.remove()
  card = el('div', { className: 'card' }, ...children)
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', 'Vault passkey')
  if (!host.isConnected) document.documentElement.append(host)
  shadow.append(card)
  shownAt = performance.now()
}

const reply = (id: string, body: Record<string, unknown>) => postMessage({ __vaultPasskeyReply: id, ...body }, location.origin)

async function handle(id: string, kind: 'create' | 'get', options: unknown) {
  const begin = await send<Begin>({ type: 'passkey:begin', kind, options })
  if (!begin || 'fallback' in begin) return reply(id, { fallback: true })
  if ('error' in begin) return reply(id, { error: begin.error })
  current = id
  const elsewhere = () => { close(); reply(id, { fallback: true }) }
  const cancel = () => { close(); reply(id, { error: { name: 'NotAllowedError', message: 'The person cancelled.' } }) }
  const finish = async (credentialId?: string) => {
    if (current !== id) return
    close()
    const r = await send<{ result?: Record<string, unknown>; error?: { name: string; message: string } }>({ type: 'passkey:finish', requestId: (begin as { requestId: string }).requestId, ...(credentialId ? { credentialId } : {}) })
    if (r?.result) reply(id, { result: r.result })
    else reply(id, { error: r?.error ?? { name: 'NotAllowedError', message: 'Vault could not complete the request.' } })
  }

  if ('locked' in begin) {
    show(el('strong', {}, 'Vault is locked'), el('div', { className: 'muted' }, `Unlock Vault from the toolbar to use your passkey for ${begin.rpId}, then try again.`),
      el('div', { className: 'row' }, button('Use another device', elsewhere), button('Open Vault', () => { void send({ type: 'inline:unlock' }); cancel() }, true)))
    return
  }
  if (begin.kind === 'create') {
    show(el('strong', {}, `Save a passkey for ${begin.rpId}?`),
      el('div', { className: 'muted' }, `${begin.userName || 'This account'} · kept in Vault, encrypted, on all your devices${begin.replaces ? '. Replaces the one Vault has.' : ''}`),
      el('div', { className: 'row' }, button('Use another device', elsewhere), button('Save in Vault', () => void finish(), true)))
    return
  }
  const list = el('div', { className: 'list' }, ...begin.accounts.map((a) =>
    button(el('span', {}, el('strong', {}, a.userName || 'Passkey'), el('span', {}, a.name)), () => void finish(a.credentialId))))
  show(el('strong', {}, `Sign in to ${begin.rpId} with Vault`), el('div', { className: 'muted' }, 'Choose a passkey.'), list,
    el('div', { className: 'row' }, button('Cancel', cancel), button('Use another device', elsewhere)))
}

addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return
  const d = e.data as { __vaultPasskey?: string; __vaultPasskeyCancel?: string; kind?: string; options?: unknown } | null
  if (d?.__vaultPasskeyCancel && d.__vaultPasskeyCancel === current) { close(); return }
  if (typeof d?.__vaultPasskey !== 'string' || (d.kind !== 'create' && d.kind !== 'get')) return
  void handle(d.__vaultPasskey, d.kind, d.options)
})

export {}
