// Making the offline copy (C4): this account's encrypted vault, as it is on
// the server, written with the offline script into one HTML file. Nothing is
// decrypted here; the file opens with the master password, anywhere, with no
// network. Its own Content-Security-Policy allows only that one script.

import { api } from './api.js'
import * as session from './session.js'

async function sha256b64(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return btoa(String.fromCharCode(...d))
}

export async function buildOfflineCopy(email: string): Promise<string> {
  const token = await session.token()
  const [me, vault, script] = await Promise.all([
    api.me(token), api.vault(token),
    fetch('/app/offline.js', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('The offline copy is not available on this server.'); return r.text() }),
  ])
  const data = {
    format: 'vault-offline', version: 1, createdAt: new Date().toISOString(), email,
    kdf: me.kdf, wrappedVaultKey: me.wrappedVaultKey,
    entries: vault.entries.map((e) => ({ id: e.id, blob: e.blob })),
    folders: vault.folders.map((f) => ({ id: f.id, blob: f.blob })),
  }
  // Inside <script type="application/json">, only "</" could end the element early.
  const json = JSON.stringify(data).replace(/<\//g, '<\\/')
  // The bundle must not close its own <script> element early.
  const safe = script.replace(/<\/script/gi, '<\\/script')
  const hash = await sha256b64(safe)
  const csp = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Vault offline copy</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#14161c;--muted:#5c6370;--line:#d8dce3;--card:#fff;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8eaf0;--muted:#9aa1ad;--line:#2a2f3a;--card:#171a21;--accent:#7c74ff}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:980px;margin:0 auto;padding:24px 16px}.muted{color:var(--muted);font-size:13px}
form,.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button{padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:inherit;font:inherit;cursor:pointer}
button[type=submit]{background:var(--accent);color:#fff;border-color:var(--accent);margin-top:12px}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:16px;margin-top:12px}@media (max-width:700px){.cols{grid-template-columns:1fr}}
ul{list-style:none;margin:0;padding:0}.row{display:flex;flex-direction:column;align-items:flex-start;width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;text-align:left}
.field{display:grid;grid-template-columns:120px minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
code{overflow-wrap:anywhere;white-space:pre-wrap}#err{color:#c0262d}
</style></head>
<body><main>
<h1>Vault offline copy</h1>
<p class="muted" id="made"></p>
<div id="locked">
<p>Everything below is encrypted. It opens here, in this file, with your master password; nothing is sent anywhere.</p>
<form id="unlock"><label for="pw">Master password</label><input id="pw" type="password" autocomplete="current-password" required autofocus>
<p id="err" role="alert"></p><button id="go" type="submit">Open</button></form>
</div>
<div id="open" hidden>
<div style="display:flex;gap:8px"><input id="q" type="search" placeholder="Search" aria-label="Search"><button id="lock" type="button">Lock</button></div>
<p class="muted" id="count"></p>
<div class="cols"><div class="panel"><ul id="list"></ul></div><div class="panel" id="detail"><p class="muted">Choose an item.</p></div></div>
</div>
<p class="muted">Read-only. Made by Vault. Keep this file somewhere safe: it is as strong as your master password. Attached files are not included.</p>
</main>
<script id="vault-data" type="application/json">${json}</script>
<script>${safe}</script>
</body></html>
`
}
