// Personal backups to Google Drive (decisions/0024) in the browser, against a
// stand-in for Google: connect, come back and sign in again, back up, and
// open the copy fetched back from the drive.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import { PASSWORD, start } from './helpers.mjs'

async function mockGoogle() {
  const codes = new Map(), files = new Map(), sessions = new Map()
  const m = { base: '', files }
  const server = createServer((req, res) => {
    const url = new URL(req.url, m.base)
    const parts = []
    req.on('data', (d) => parts.push(d))
    req.on('end', () => {
      const body = Buffer.concat(parts)
      const send = (s, v, h = {}) => { res.writeHead(s, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(v)) }
      if (url.pathname === '/g/auth') {
        const code = randomBytes(8).toString('hex'); codes.set(code, url.searchParams.get('code_challenge'))
        const back = new URL(url.searchParams.get('redirect_uri')); back.searchParams.set('code', code); back.searchParams.set('state', url.searchParams.get('state'))
        res.writeHead(302, { location: back.toString() }); return res.end()
      }
      if (url.pathname === '/g/token') {
        const f = new URLSearchParams(body.toString())
        if (f.get('grant_type') === 'authorization_code') {
          const ok = codes.get(f.get('code')) === createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url')
          return ok ? send(200, { access_token: 'a', refresh_token: 'r', id_token: `x.${Buffer.from(JSON.stringify({ email: 'bea@gmail.example' })).toString('base64url')}.y` }) : send(400, { error: 'invalid_grant' })
        }
        return send(200, { access_token: 'a' })
      }
      if (url.pathname === '/gapi/drive/v3/files' && req.method === 'POST') return send(200, { id: 'folder' })
      if (url.pathname === '/gapi/upload/drive/v3/files') { const sid = randomBytes(4).toString('hex'); sessions.set(sid, JSON.parse(body).name); return send(200, {}, { location: `${m.base}/gapi/s/${sid}` }) }
      if (url.pathname.startsWith('/gapi/s/')) { const id = randomBytes(4).toString('hex'); files.set(id, body); return send(200, { id }) }
      const g = url.pathname.match(/^\/gapi\/drive\/v3\/files\/(.+)$/)
      if (g) { if (req.method === 'DELETE') { files.delete(g[1]); res.writeHead(204); return res.end() } res.writeHead(200); return res.end(files.get(g[1])) }
      send(404, {})
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  m.base = `http://127.0.0.1:${server.address().port}`
  m.close = () => new Promise((r) => server.close(r))
  return m
}

test('connect Google Drive, sign in again, back up to it, and open the copy', async () => {
  const google = await mockGoogle()
  const s = await start({ env: { CLOUD_MOCK: google.base } })
  try {
    const page = await s.person()
    await s.register(page, 'bea@example.test')
    await page.click('.topbar .btn-primary')
    await page.fill('#f-name', 'Bank')
    await page.fill('#f-password', 'a-long-strong-and-unique-password-1')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Bank")')

    await s.settings(page, 'Backups')
    await page.getByLabel(/Google Drive/).check()
    await page.getByRole('button', { name: 'Connect Google Drive' }).click()
    // Off to "Google" and back: the page reloads, so the vault asks to unlock again.
    await page.waitForURL(/\/app\/settings\/backups/)
    await s.unlock(page, 'bea@example.test')
    await page.waitForSelector('text=Google Drive connected. Backups now go there.', { state: 'attached' })
    await page.waitForSelector('text=Connected as')
    assert.match(await page.textContent('.facts'), /Google Drive · bea@gmail\.example/)

    await page.getByRole('button', { name: 'Back up now' }).click()
    await page.waitForSelector('text=Backed up 1 item')
    assert.equal(google.files.size, 1)
    await page.waitForSelector('#b-test-secret, button:has-text("Test restore…")')
    if (!(await page.locator('#b-test-secret').count())) await page.getByRole('button', { name: 'Test restore…' }).click()
    await page.fill('#b-test-secret', PASSWORD)
    await page.getByRole('button', { name: 'Test', exact: true }).click()
    await page.waitForSelector('.test-restore .alert', { timeout: 60_000 })
    assert.match(await page.textContent('.test-restore .alert'), /1 item/)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
    await google.close()
  }
})
