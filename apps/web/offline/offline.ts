// The offline copy (C4): one HTML file holding an encrypted copy of a vault
// and this script, which opens it with the master password — no server, no
// network. Built from the same crypto and item packages as the app, so it
// decrypts exactly as the app does. The page's own policy allows no requests.

import { fromBase64Url, kdfProblem, openEntry, openFolder, parseSecretKey, unlock, wipe, type EntryContent, type KdfParams } from '@vault/crypto'
import { folderPath, readField, typeSpec } from '@vault/core'

interface OfflineFile {
  format: 'vault-offline'
  version: 1
  createdAt: string
  email: string
  kdf: KdfParams & { salt: string }
  wrappedVaultKey: string
  entries: { id: string; blob: string }[]
  folders: { id: string; blob: string }[]
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const el = (tag: string, attrs: Record<string, string> = {}, text?: string) => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (text !== undefined) e.textContent = text
  return e
}

const data = JSON.parse(($('#vault-data') as HTMLScriptElement).textContent ?? '{}') as OfflineFile
$('#made').textContent = `${data.email} · made ${new Date(data.createdAt).toLocaleString()}`

// An account with a secret key (decisions/0027) needs it here too.
if (data.kdf.version === 2) $('#skrow').hidden = false

let items: (EntryContent & { id: string; path: string })[] = []

$('#unlock').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const pw = ($('#pw') as HTMLInputElement).value
  const err = $('#err')
  err.textContent = ''
  ;($('#go') as HTMLButtonElement).disabled = true
  try {
    if (data.kdf.algorithm === 'PBKDF2-HMAC-SHA256' ? data.kdf.iterations < 600_000 || data.kdf.iterations > 10_000_000 : kdfProblem(data.kdf) !== null) throw new Error('bad kdf')
    const sk = data.kdf.version === 2 ? await parseSecretKey(($('#sk') as HTMLInputElement).value) : undefined
    const { vaultKey } = await unlock(pw, data.kdf, data.wrappedVaultKey, fromBase64Url(data.kdf.salt), sk)
    try {
      const folders = (await Promise.all(data.folders.map(async (f) => { try { return { ...(await openFolder(f.id, f.blob, vaultKey)), id: f.id } } catch { return null } }))).filter((f) => f !== null)
      items = (await Promise.all(data.entries.map(async (e) => {
        try { const c = await openEntry(e.id, e.blob, vaultKey); return { ...c, id: e.id, path: folderPath(folders as never, c.folderId) } } catch { return null }
      }))).filter((x): x is EntryContent & { id: string; path: string } => x !== null && !x.archived)
      items.sort((a, b) => a.name.localeCompare(b.name))
    } finally { wipe(vaultKey) }
    ;($('#pw') as HTMLInputElement).value = ''
    $('#locked').hidden = true
    $('#open').hidden = false
    render('')
  } catch {
    err.textContent = data.kdf.version === 2
      ? 'That master password and secret key do not open this copy. It needs the ones you had when the copy was made.'
      : 'That master password does not open this copy. It needs the one you had when the copy was made.'
  } finally {
    ;($('#go') as HTMLButtonElement).disabled = false
  }
})

$('#q').addEventListener('input', (e) => render((e.target as HTMLInputElement).value))
$('#lock').addEventListener('click', () => { items = []; $('#list').replaceChildren(); $('#detail').replaceChildren(); $('#open').hidden = true; $('#locked').hidden = false })

function render(q: string) {
  const needle = q.trim().toLowerCase()
  const list = $('#list')
  list.replaceChildren()
  for (const it of items.filter((i) => !needle || `${i.name} ${i.username ?? ''} ${i.url ?? ''} ${i.path}`.toLowerCase().includes(needle))) {
    const b = el('button', { class: 'row' })
    b.append(el('strong', {}, it.name || 'Untitled'), el('span', { class: 'muted' }, [typeSpec(it.type).label, it.path].filter(Boolean).join(' · ')))
    b.addEventListener('click', () => show(it))
    list.append(el('li', {}, undefined)); list.lastElementChild!.append(b)
  }
  $('#count').textContent = `${list.children.length} item${list.children.length === 1 ? '' : 's'}`
}

function show(it: EntryContent & { path: string }) {
  const d = $('#detail')
  d.replaceChildren(el('h2', {}, it.name || 'Untitled'), el('p', { class: 'muted' }, [typeSpec(it.type).label, it.path].filter(Boolean).join(' · ')))
  const rows: [string, string, boolean][] = typeSpec(it.type).fields.map((f) => [f.label, readField(it, f), f.kind === 'secret' || f.kind === 'secretBlock' || f.kind === 'totp'])
  for (const c of it.customFields ?? []) rows.push([c.label || 'Field', c.value, c.hidden])
  if (it.notes) rows.push(['Notes', it.notes, false])
  for (const [label, value, secret] of rows) {
    if (!value) continue
    const row = el('div', { class: 'field' })
    const v = el('code', {}, secret ? '••••••••••••' : value)
    row.append(el('span', { class: 'muted' }, label), v)
    if (secret) {
      const r = el('button', { type: 'button' }, 'Show')
      r.addEventListener('click', () => { const on = v.textContent !== value; v.textContent = on ? value : '••••••••••••'; r.textContent = on ? 'Hide' : 'Show' })
      row.append(r)
    }
    const c = el('button', { type: 'button' }, 'Copy')
    c.addEventListener('click', () => { void navigator.clipboard.writeText(value).then(() => { c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy' }, 1200) }) })
    row.append(c)
    d.append(row)
  }
}
