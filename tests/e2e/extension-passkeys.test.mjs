// Passkeys in Vault (decisions/0035), for real: Chromium with the extension,
// and a relying party that verifies with @simplewebauthn/server, as a real
// site would. Vault saves a passkey when the site offers one, signs in with
// it, keeps it in the vault, and refuses a page that claims another site.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'

import { chromium } from 'playwright-core'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'

import { PASSWORD, start } from './helpers.mjs'

const ROOT = new URL('../../', import.meta.url).pathname
const EXT = `${ROOT}apps/extension/dist/chrome-test`
const EMAIL = 'keys@example.test'

const PAGE = (rpId) => `<!doctype html><title>Example passkeys</title>
<button id="reg">Create a passkey</button> <button id="login">Sign in with a passkey</button>
<p id="out">ready</p>
<script>
const b = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0))
const out = (t) => { document.getElementById('out').textContent = t }
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
document.getElementById('reg').onclick = async () => {
  try {
    const o = await (await fetch('/reg-options')).json()
    const cred = await navigator.credentials.create({ publicKey: { ...o, rp: { ...o.rp, id: ${JSON.stringify(rpId)} }, challenge: b(o.challenge), user: { ...o.user, id: b(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b(c.id) })) } })
    const r = await post('/reg-verify', cred.toJSON())
    out(r.ok ? 'registered ' + cred.response.getPublicKeyAlgorithm() + ' ' + cred.response.getTransports().join(',') : 'refused ' + r.error)
  } catch (e) { out('error ' + e.name) }
}
document.getElementById('login').onclick = async () => {
  try {
    const o = await (await fetch('/auth-options')).json()
    const cred = await navigator.credentials.get({ publicKey: { ...o, rpId: ${JSON.stringify(rpId)}, challenge: b(o.challenge), allowCredentials: [] } })
    const r = await post('/auth-verify', cred.toJSON())
    out(r.ok ? 'signed in as ' + r.user : 'refused ' + r.error)
  } catch (e) { out('error ' + e.name) }
}
</script>`

/** A relying party at http://localhost:<port>, which keeps one user's passkeys. */
async function relyingParty() {
  let challenge = ''
  const creds = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    for await (const d of req) body += d
    const json = (v) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)) }
    const origin = `http://localhost:${server.address().port}`
    try {
      if (url.pathname === '/reg-options') {
        const o = await generateRegistrationOptions({ rpName: 'Example', rpID: 'localhost', userName: 'ana@example.com', userID: new TextEncoder().encode('user-ana'), attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' } })
        challenge = o.challenge
        return json(o)
      }
      if (url.pathname === '/reg-verify') {
        const r = await verifyRegistrationResponse({ response: JSON.parse(body), expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: 'localhost' })
        if (r.verified) creds.push(r.registrationInfo.credential)
        return json({ ok: r.verified })
      }
      if (url.pathname === '/auth-options') {
        const o = await generateAuthenticationOptions({ rpID: 'localhost', userVerification: 'preferred' })
        challenge = o.challenge
        return json(o)
      }
      if (url.pathname === '/auth-verify') {
        const resp = JSON.parse(body)
        const cred = creds.find((c) => c.id === resp.id)
        if (!cred) return json({ ok: false, error: 'unknown credential' })
        const r = await verifyAuthenticationResponse({ response: resp, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: 'localhost', credential: cred })
        return json({ ok: r.verified, user: new TextDecoder().decode(Uint8Array.from(atob(resp.response.userHandle.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))) })
      }
      res.setHeader('content-type', 'text/html')
      res.end(PAGE(url.searchParams.get('rp') ?? 'localhost'))
    } catch (e) { json({ ok: false, error: String(e.message ?? e) }) }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}

async function launch() {
  const exe = [process.env.EXT_CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p))
  const ctx = await chromium.launchPersistentContext('', { ...(exe ? { executablePath: exe } : {}), headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] })
  const ours = (w) => w.url().endsWith('/background.js')
  const worker = ctx.serviceWorkers().find(ours) ?? await ctx.waitForEvent('serviceworker', { predicate: ours })
  for (let i = 0; i < 100 && !(await worker.evaluate(() => !!globalThis.chrome?.tabs)); i++) await new Promise((r) => setTimeout(r, 50))
  return { ctx, worker, id: new URL(worker.url()).host }
}

/** The card Vault shows in the page (an open shadow root in the test build). */
const card = (page) => page.locator('vault-passkey').locator('.card')

test('Vault saves a passkey a site offers, signs in with it, and keeps it in the vault', async () => {
  execFileSync('node', [`${ROOT}apps/extension/scripts/build.mjs`, '--test'], { stdio: 'ignore' })
  const s = await start({ owner: EMAIL })
  const rp = await relyingParty()
  let ctx
  try {
    const web = await s.person()
    await s.register(web, EMAIL)

    let id
    ;({ ctx, id } = await launch())
    const popup = await ctx.newPage()
    await popup.goto(`chrome-extension://${id}/popup.html`)
    await popup.fill('#server', s.base)
    await popup.getByRole('button', { name: 'Connect' }).click()
    await popup.waitForSelector('h1:has-text("Unlock")')
    await popup.fill('#email', EMAIL)
    await popup.fill('#password', PASSWORD)
    await popup.getByRole('button', { name: 'Unlock' }).click()
    await popup.getByLabel('Save and use passkeys in Vault').click({ timeout: 60_000 })
    await popup.waitForSelector('text=When a site offers a passkey')

    // The site offers a passkey; Vault asks, and keeps it.
    const site = await ctx.newPage()
    await site.goto(`http://localhost:${rp.port}/`)
    await site.click('#reg')
    await card(site).waitFor()
    assert.match(await card(site).textContent(), /Save a passkey for localhost\?.*ana@example\.com/)
    await site.waitForTimeout(700) // the card ignores clicks in its first moments
    await card(site).getByRole('button', { name: 'Save in Vault' }).click()
    await site.waitForSelector('#out:has-text("registered")')
    assert.equal(await site.textContent('#out'), 'registered -7 internal,hybrid', 'the relying party verified it')

    // Signing in: Vault lists the passkey; the site verifies the assertion.
    await site.click('#login')
    await card(site).waitFor()
    await site.waitForTimeout(700)
    await card(site).getByRole('button', { name: /ana@example\.com/ }).click()
    await site.waitForSelector('#out:has-text("signed in")')
    assert.equal(await site.textContent('#out'), 'signed in as user-ana')

    // Cancel is the person's no: the site hears NotAllowedError.
    await site.click('#login')
    await card(site).waitFor()
    await site.waitForTimeout(700)
    await card(site).getByRole('button', { name: 'Cancel' }).click()
    await site.waitForSelector('#out:has-text("error NotAllowedError")')

    // A page that claims another site's rpId is refused before anyone is asked.
    const evil = await ctx.newPage()
    await evil.goto(`http://localhost:${rp.port}/?rp=example.com`)
    await evil.click('#login')
    await evil.waitForSelector('#out:has-text("error SecurityError")')
    assert.equal(await card(evil).count(), 0)

    // The passkey is in the vault, in a login for the site.
    await web.reload()
    await s.unlock(web, EMAIL)
    await web.locator('.row-item', { hasText: 'localhost' }).click()
    await web.waitForSelector('.detail :text("Passkey")')
    assert.match(await web.textContent('.detail'), /ana@example\.com/)
    assert.deepEqual(s.errors, [])
  } finally {
    await ctx?.close()
    rp.server.close()
    await s.stop()
  }
})
