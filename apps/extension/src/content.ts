// Inside pages, when the person turns it on (decisions/0029, stage 3): an icon
// in login fields that lists this site's logins, "generate" in sign-up forms,
// and an offer to save or update a password after it is submitted.
//
// It runs in the top frame only, registered at run time after the person
// grants the optional all-sites permission. It never holds the vault: it asks
// the background, which answers only with logins that match this page's URL as
// the browser reports it. Its UI lives in a closed shadow root, so the page's
// own scripts cannot read the list, and every string is set as text.

declare const __VAULT_TEST__: boolean

interface Match { id: string; name: string; username: string }
interface Offer { kind: 'save' | 'update'; host: string; username: string; name?: string }

const send = <T>(message: Record<string, unknown>): Promise<T | undefined> =>
  chrome.runtime.sendMessage(message).then((r: { result?: T } | undefined) => r?.result).catch(() => undefined)

const shown = (el: HTMLElement) => {
  const r = el.getBoundingClientRect()
  const s = getComputedStyle(el)
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
}
const textual = (i: HTMLInputElement) => ['text', 'email', 'tel', ''].includes(i.type) || i.autocomplete === 'username'
const named = (i: HTMLInputElement) => /user|email|login|account|identifier/i.test(`${i.autocomplete} ${i.name} ${i.id}`)
const inputs = (root: ParentNode = document) => Array.from(root.querySelectorAll('input')).filter((i) => !i.disabled && shown(i))

/** The username field that goes with a password field, if any. */
function usernameFor(pw: HTMLInputElement): HTMLInputElement | null {
  const scope = inputs(pw.form ?? document)
  const before = scope.slice(0, scope.indexOf(pw)).filter(textual)
  return before.find(named) ?? before[before.length - 1] ?? null
}

/** A field the icon belongs in: a password field, or the username before one
 *  (or alone, on the first step of a two-step sign-in). */
function relevant(el: EventTarget | null): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false
  if (el.type === 'password') return true
  if (!textual(el)) return false
  if (el.autocomplete === 'username') return true
  const pw = inputs(el.form ?? document).find((i) => i.type === 'password')
  return pw ? usernameFor(pw) === el : named(el) && !!el.form
}

/** A sign-up or change-password field: generate rather than fill. */
function wantsNewPassword(el: HTMLInputElement): boolean {
  if (el.type !== 'password') return false
  if (el.autocomplete === 'new-password') return true
  return inputs(el.form ?? document).filter((i) => i.type === 'password').length >= 2
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  el.focus()
  if (setter) setter.call(el, value); else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

// ── The shadow UI ──────────────────────────────────────────────────────────

const host = document.createElement('vault-inline')
const shadow = host.attachShadow({ mode: __VAULT_TEST__ ? 'open' : 'closed' })
let active = false
const style = document.createElement('style')
style.textContent = `
:host { all: initial; }
* { box-sizing: border-box; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
.icon { position: fixed; z-index: 2147483647; width: 22px; height: 22px; padding: 3px; border: 0; border-radius: 6px; background: transparent; cursor: pointer; }
.icon:hover, .icon:focus-visible { background: rgba(79, 70, 229, .15); outline: none; }
.icon svg { width: 16px; height: 16px; display: block; }
.menu, .bar { position: fixed; z-index: 2147483647; background: #fff; color: #121620; border: 1px solid #dfe3ea; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 6px; min-width: 240px; max-width: 340px; }
.menu button, .bar button { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: inherit; padding: 7px 9px; border-radius: 7px; cursor: pointer; }
.menu button:hover, .menu button:focus-visible { background: #eef0ff; outline: none; }
.menu strong, .bar strong { display: block; font-weight: 600; }
.menu span, .bar span, .muted { color: #4a5263; font-size: 12px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { padding: 7px 9px; white-space: normal; }
.bar { top: 16px; right: 16px; padding: 12px; }
.bar .row { display: flex; gap: 6px; margin-top: 10px; }
.bar .row button { width: auto; text-align: center; border: 1px solid #dfe3ea; padding: 6px 12px; }
.bar .row .primary { background: #4f46e5; border-color: #4f46e5; color: #fff; font-weight: 600; }
@media (prefers-color-scheme: dark) {
  .menu, .bar { background: #12151c; color: #e8eaf0; border-color: #262b36; }
  .menu button:hover, .menu button:focus-visible { background: #1d1b3a; }
  .menu span, .bar span, .muted { color: #b4bac7; }
  .bar .row button { border-color: #262b36; }
}`
shadow.append(style)

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/** The toolbar icon, drawn inline: an image file would have to be exposed to
 *  every website (web_accessible_resources), and a data: URL can be blocked
 *  by a page's own policy. */
function logo(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('aria-hidden', 'true')
  const rect = document.createElementNS(ns, 'rect')
  for (const [k, v] of Object.entries({ width: '32', height: '32', rx: '8', fill: '#4f46e5' })) rect.setAttribute(k, v)
  const shield = document.createElementNS(ns, 'path')
  for (const [k, v] of Object.entries({ d: 'M16 6.5 9 9.2v5.3c0 4 2.9 7.4 7 8 4.1-.6 7-4 7-8V9.2l-7-2.7Z', fill: 'none', stroke: '#fff', 'stroke-width': '2', 'stroke-linejoin': 'round' })) shield.setAttribute(k, v)
  const tick = document.createElementNS(ns, 'path')
  for (const [k, v] of Object.entries({ d: 'm12.8 15 2.3 2.3 4.1-4.3', fill: 'none', stroke: '#fff', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) tick.setAttribute(k, v)
  svg.append(rect, shield, tick)
  return svg
}

const icon = el('button', { className: 'icon', type: 'button', title: 'Vault' }, logo())
icon.setAttribute('aria-label', 'Vault: logins for this site')
let field: HTMLInputElement | null = null
let menu: HTMLElement | null = null
let bar: HTMLElement | null = null

function place() {
  if (!field || !field.isConnected || !shown(field)) { icon.remove(); return }
  const r = field.getBoundingClientRect()
  icon.style.top = `${r.top + (r.height - 22) / 2}px`
  icon.style.left = `${r.right - 26}px`
  if (menu) { menu.style.top = `${r.bottom + 4}px`; menu.style.left = `${Math.max(8, r.left)}px` }
}

function closeMenu() { menu?.remove(); menu = null }

async function openMenu() {
  if (!field) return
  closeMenu()
  const target = field
  menu = el('div', { className: 'menu' })
  menu.setAttribute('role', 'menu')
  shadow.append(menu)
  place()
  const res = await send<{ locked?: boolean; matches?: Match[] }>({ type: 'inline:list' })
  if (!menu || field !== target) return
  if (wantsNewPassword(target)) {
    const gen = el('button', { type: 'button' }, el('strong', {}, 'Generate a strong password'), el('span', {}, 'Saved to Vault when you submit'))
    gen.setAttribute('role', 'menuitem')
    gen.addEventListener('click', async () => {
      const r = await send<{ password: string }>({ type: 'inline:generate' })
      if (!r) return
      for (const p of inputs(target.form ?? document).filter((i) => i.type === 'password' && (wantsNewPassword(i) || !i.value))) setValue(p, r.password)
      closeMenu()
    })
    menu.append(gen)
  }
  if (!res || res.locked) {
    const unlock = el('button', { type: 'button' }, el('strong', {}, 'Vault is locked'), el('span', {}, 'Unlock from the toolbar button'))
    unlock.addEventListener('click', () => { void send({ type: 'inline:unlock' }); closeMenu() })
    menu.append(unlock)
    return
  }
  if (!res.matches?.length) {
    if (!wantsNewPassword(target)) menu.append(el('p', { className: 'muted' }, 'No saved login for this site.'))
    return
  }
  for (const m of res.matches) {
    const item = el('button', { type: 'button' }, el('strong', {}, m.name), el('span', {}, m.username || '—'))
    item.setAttribute('role', 'menuitem')
    item.addEventListener('click', () => { void send({ type: 'inline:fill', id: m.id }); closeMenu() })
    menu.append(item)
  }
}

icon.addEventListener('mousedown', (e) => e.preventDefault()) // keep the field focused
icon.addEventListener('click', () => { if (menu) closeMenu(); else void openMenu() })

document.addEventListener('focusin', (e) => {
  if (!active) return
  const t = e.composedPath()[0] ?? e.target
  if (t === icon || (menu && menu.contains(t as Node))) return
  if (relevant(t)) { field = t; shadow.append(icon); place(); closeMenu() }
  else if (!(t instanceof Node && host.contains(t))) { field = null; icon.remove(); closeMenu() }
}, true)
document.addEventListener('mousedown', (e) => { if (menu && !e.composedPath().includes(host)) closeMenu() }, true)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu() }, true)
addEventListener('scroll', () => requestAnimationFrame(place), true)
addEventListener('resize', () => requestAnimationFrame(place))

// ── Save and update ────────────────────────────────────────────────────────

let lastSent = ''

/** What was typed into a form being submitted: the last filled password field
 *  (the new one, in a change-password form) and its username. */
function capture(form: ParentNode) {
  const pws = inputs(form).filter((i) => i.type === 'password' && i.value)
  const pw = pws[pws.length - 1]
  if (!pw) return
  const username = (pws[0] ? usernameFor(pws[0])?.value : '') ?? ''
  const key = `${username}\n${pw.value}`
  if (key === lastSent) return
  lastSent = key
  void send<{ offer?: Offer }>({ type: 'inline:submitted', username, password: pw.value }).then((r) => {
    // A page that stays (a single-page app) is asked straight away; one that
    // navigates asks again when the next page loads.
    if (r?.offer) setTimeout(() => { if (!bar) void showOffer() }, 1200)
  })
}

document.addEventListener('submit', (e) => { if (active && e.target instanceof HTMLFormElement) capture(e.target) }, true)
document.addEventListener('click', (e) => {
  if (!active) return
  const b = (e.composedPath()[0] as Element | undefined)?.closest?.('button, input[type=submit]')
  if (!b) return
  const form = (b as HTMLButtonElement).form ?? b.closest('form') ?? document
  if (inputs(form).some((i) => i.type === 'password' && i.value)) capture(form)
}, true)
document.addEventListener('keydown', (e) => {
  if (active && e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'password' && e.target.value) capture(e.target.form ?? document)
}, true)

async function showOffer() {
  const offer = (await send<{ offer?: Offer }>({ type: 'inline:offer' }))?.offer
  if (!offer || bar) return
  const answer = async (save: boolean) => { bar?.remove(); bar = null; await send({ type: 'inline:answer', save }) }
  const yes = el('button', { type: 'button', className: 'primary' }, offer.kind === 'save' ? 'Save' : 'Update')
  const no = el('button', { type: 'button' }, 'Not now')
  yes.addEventListener('click', () => void answer(true))
  no.addEventListener('click', () => void answer(false))
  bar = el('div', { className: 'bar' },
    el('strong', {}, offer.kind === 'save' ? `Save this login to Vault?` : `Update the password for ${offer.name ?? offer.host}?`),
    el('span', {}, `${offer.username || 'No username'} · ${offer.host}`),
    el('div', { className: 'row' }, yes, no))
  bar.setAttribute('role', 'dialog')
  bar.setAttribute('aria-label', 'Vault')
  shadow.append(bar)
}

// Start: only where the background says so (never on the Vault server's own
// pages, where the master password is typed).
void send<{ active: boolean }>({ type: 'inline:hello' }).then((r) => {
  if (!r?.active) return
  active = true
  document.documentElement.append(host)
  void showOffer()
})
