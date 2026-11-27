#!/usr/bin/env node
// Fills a Vault server with demo people, so every role and flow can be tried:
// personal accounts, and two companies ("tenants") each with an admin,
// members, groups, collections and shared items. It drives the real web app
// in a browser, so every key is derived and sealed exactly as a person's
// would be; the server never sees anything it would not see anyway.
//
//   BASE=https://vault.example.com \
//   OWNER_EMAIL=… OWNER_PASSWORD=… DEMO_PASSWORD=… \
//   node scripts/demo-seed.mjs
//
// OWNER_* is the server owner's account (it creates the invitations).
// Every demo account gets DEMO_PASSWORD. Nothing is printed that unlocks
// anything; organization recovery keys go to DEMO_OUT (default
// ./demo-accounts.json), which should be kept with the passwords, not in git.
// Re-running skips what DEMO_OUT says is done. The server's sign-in rate limit
// (10 per 15 minutes per address) is waited out when it is hit.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const BASE = (process.env.BASE ?? '').replace(/\/$/, '')
const { OWNER_EMAIL, OWNER_PASSWORD, DEMO_PASSWORD } = process.env
// The account password of every demo account (decisions/0036); the owner's is
// OWNER_ACCOUNT_PASSWORD (or OWNER_PASSWORD, when the owner chose the same).
const DEMO_ACCOUNT_PASSWORD = process.env.DEMO_ACCOUNT_PASSWORD ?? ''
const OWNER_ACCOUNT_PASSWORD = process.env.OWNER_ACCOUNT_PASSWORD ?? OWNER_PASSWORD
const OUT = process.env.DEMO_OUT ?? 'demo-accounts.json'
if (!BASE || !OWNER_EMAIL || !OWNER_PASSWORD || !DEMO_PASSWORD || !DEMO_ACCOUNT_PASSWORD) {
  console.error('Set BASE, OWNER_EMAIL, OWNER_PASSWORD, DEMO_PASSWORD and DEMO_ACCOUNT_PASSWORD.')
  process.exit(2)
}

// ── Who ─────────────────────────────────────────────────────────────────────

// Reserved .example addresses: the server never mails them (decisions/0037).
const FIRST = ['Priya', 'Rahul', 'Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Sara', 'Vikram', 'Ananya', 'Arjun', 'Isha', 'Nikhil', 'Pooja', 'Siddharth', 'Tanvi', 'Yash', 'Zoya', 'Dev', 'Neha']
const SITES = [
  ['Gmail', 'https://mail.google.com'], ['Netflix', 'https://netflix.com'], ['GitHub', 'https://github.com'], ['Amazon', 'https://amazon.in'],
  ['HDFC NetBanking', 'https://netbanking.hdfcbank.com'], ['LinkedIn', 'https://linkedin.com'], ['Spotify', 'https://spotify.com'], ['Swiggy', 'https://swiggy.com'],
]
// Twenty people with their own vaults, none in an organization.
const PERSONAL = FIRST.map((name, i) => ({
  email: `${name.toLowerCase()}@personal.example`, name,
  items: [0, 1, 2].map((k) => { const [site, url] = SITES[(i + k * 3) % SITES.length]; return [site, `${name.toLowerCase()}${k ? `.${k}` : ''}@mail.example`, url] }),
}))

// Five companies of 5 to 8 people each. Nobody is also a personal account:
// one address is one account (the server refuses a second).
const COMPANIES = [
  { org: 'Acme Corp', domain: 'acme.example', admin: 'Anita', people: ['Ben', 'Chen', 'Divya', 'Farhan', 'Gauri'] },
  { org: 'Globex', domain: 'globex.example', admin: 'Gita', people: ['Hari', 'Irfan', 'Jaya', 'Karan'] },
  { org: 'Initech', domain: 'initech.example', admin: 'Lata', people: ['Manoj', 'Nisha', 'Omar', 'Parul', 'Qasim', 'Ritu'] },
  { org: 'Umbrella Health', domain: 'umbrella.example', admin: 'Sameer', people: ['Tara', 'Uday', 'Vani', 'Waseem', 'Ximena', 'Yusuf', 'Zara'] },
  { org: 'Stark Logistics', domain: 'stark.example', admin: 'Aditi', people: ['Bharat', 'Chitra', 'Dhruv', 'Esha', 'Faisal'] },
]
const TENANTS = COMPANIES.map((c) => {
  const members = c.people.map((n) => ({ email: `${n.toLowerCase()}@${c.domain}`, name: n }))
  const team = members.map((m) => m.email)
  return {
    org: c.org,
    admin: { email: `${c.admin.toLowerCase()}@${c.domain}`, name: `${c.admin} (admin)` },
    members,
    groups: [{ name: 'Team', members: team }],
    collections: [
      { name: 'Team', group: 'Team', perm: 'edit', items: [['Slack', `team@${c.domain}`, `https://${c.org.split(' ')[0].toLowerCase()}.slack.com`], ['Grafana', 'admin', `https://grafana.${c.domain}`]] },
      { name: 'Finance', people: [{ email: members[0].email, perm: 'view', hide: true }], items: [['Payroll portal', `payroll@${c.domain}`, `https://payroll.${c.domain}`]] },
    ],
    items: [['Company email', `${c.admin.toLowerCase()}@${c.domain}`, `https://mail.${c.domain}`]],
  }
})

// ── State ───────────────────────────────────────────────────────────────────

const state = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { server: BASE, accounts: {}, tenants: {} }
// The same server under a new address (a domain move) keeps its state.
state.server = BASE
const save = () => writeFileSync(OUT, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strong = () => `Demo-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 8)}!9K`

// ── Browser ─────────────────────────────────────────────────────────────────

const exe = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p))
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true })
const pages = new Map()

// DEMO_LOCAL=1, against a local dev stack only: each person gets their own
// client address, so the per-address sign-in limit does not slow a test run.
let people = 0
async function newPage() {
  const local = process.env.DEMO_LOCAL === '1' ? { extraHTTPHeaders: { 'x-forwarded-for': `10.9.0.${++people}` } } : {}
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, ...local })
  // Not the owner's first-run wizard: this script is not setting up a server.
  await ctx.addInitScript(() => { try { localStorage.setItem('vault.setup-wizard.done', '1') } catch { /* no storage */ } })
  return ctx.newPage()
}

/** Opens a URL, retrying through a passing network or DNS failure. */
async function go(page, url) {
  for (let i = 1; ; i++) {
    try { await page.goto(url); return } catch (err) {
      if (i >= 6) throw err
      log(`could not open ${url} (${String(err).split('\n')[0]}); retrying`)
      await sleep(10_000 * i)
    }
  }
}

/** Waits out the sign-in rate limit when the page says it was hit. */
async function rateLimited(page) {
  const alert = page.locator('.alert-error')
  if (!(await alert.count())) return false
  const text = await alert.first().innerText()
  const m = /Try again in (\d+) minute/.exec(text)
  // A passing network failure: wait a little and try again.
  if (/Could not reach the server/.test(text)) { log('network trouble; retrying in 20 s'); await sleep(20_000); return true }
  if (!/Too many attempts/.test(text)) throw new Error(text)
  const minutes = m ? Number(m[1]) : 15
  log(`rate limited; waiting ${minutes} min`)
  await sleep(minutes * 60_000 + 10_000)
  return true
}

/** Signs in (decisions/0036): the account, then the master password. An
 *  account from before account passwords signs in once with the master
 *  password and is given its account password. */
async function unlock(page, email, password) {
  signIns.set(page, { email, password })
  const accountPassword = email === OWNER_EMAIL ? OWNER_ACCOUNT_PASSWORD : DEMO_ACCOUNT_PASSWORD
  for (;;) {
    await go(page, `${BASE}/app/`)
    await page.locator('#account-password, .account-line').first().waitFor({ timeout: 60_000 })
    if (await page.locator('.account-line').count()) {
      if ((await page.textContent('.account-line strong'))?.trim() !== email) { await page.getByRole('button', { name: 'Not you? Sign out' }).click(); continue }
    } else {
      await page.fill('#email', email)
      await page.fill('#account-password', accountPassword)
      await page.click('button[type=submit]')
      const r = await Promise.race([
        page.waitForSelector('.account-line', { timeout: 90_000 }).then(() => 'in'),
        page.waitForSelector('.alert-error', { timeout: 90_000 }).then(() => 'error'),
      ])
      if (r === 'error') {
        if ((await page.textContent('.alert-error'))?.includes('Wrong email or account password')) { await legacy(page, email, password, accountPassword); return }
        if (await rateLimited(page)) continue
        throw new Error(`${email}: ${await page.textContent('.alert-error')}`)
      }
    }
    await page.locator('button[type=submit]:not([disabled])').first().waitFor({ timeout: 30_000 }).catch(() => {})
    await page.fill('#password', password)
    await page.click('button[type=submit]')
    const r = await Promise.race([
      page.waitForSelector('.topbar', { timeout: 90_000 }).then(() => 'ok'),
      page.waitForSelector('.alert-error', { timeout: 90_000 }).then(() => 'error'),
    ])
    if (r === 'ok') return
    if (!(await rateLimited(page))) throw new Error(`${email}: ${await page.textContent('.alert-error')}`)
  }
}

/** The one-time sign-in of an account that has no account password yet. */
async function legacy(page, email, password, accountPassword) {
  // Behind "Other ways to sign in" since the sign-in page was simplified; the
  // old link, on a server from before it.
  const other = page.getByRole('button', { name: 'Other ways to sign in' })
  if (await other.count()) { await other.click(); await page.getByRole('button', { name: /Use my master password/ }).click() }
  else await page.getByRole('button', { name: /First sign-in since accounts were added/ }).click()
  await page.fill('#email', email)
  await page.fill('#password', password)
  await page.click('button[type=submit]')
  await page.locator('#new-account').or(page.locator('.alert-error')).first().waitFor({ timeout: 90_000 })
  if (await page.locator('.alert-error').count()) throw new Error(`${email}: ${await page.textContent('.alert-error')}`)
  await page.fill('#new-account', accountPassword)
  await page.fill('#new-account-confirm', accountPassword)
  await page.getByRole('button', { name: 'Save and open my vault' }).click()
  await page.waitForSelector('.topbar', { timeout: 90_000 })
  log(`${email}: account password set`)
}

/** Who each page is signed in as, to unlock it again after the idle lock:
 *  the rate-limit waits are longer than the 15-minute idle limit. */
const signIns = new Map()

async function menu(page, item) {
  if (!(await page.locator('.topbar').count()) && signIns.has(page)) {
    const { email, password } = signIns.get(page)
    log(`${email}: locked while idle; unlocking`)
    await unlock(page, email, password)
  }
  await page.getByRole('button', { name: 'Account menu' }).click()
  // Names changed with the admin console (decisions/0031); accept both.
  const name = item === 'Admin' ? /^(Admin panel|Admin console)$/ : item === 'Organizations' ? /^(My organizations|Organizations)$/ : item
  await page.getByRole('menuitem', { name }).click()
}

async function inviteCode(owner, label) {
  await menu(owner, 'Admin')
  await owner.locator('.sidebar .side-item', { hasText: 'Invitations' }).click()
  await owner.fill('#inv-label', label)
  await owner.getByRole('button', { name: 'Create invitation' }).click()
  const code = (await owner.locator('.recovery-key code').first().innerText()).trim()
  await owner.getByRole('button', { name: 'Done' }).click()
  return code
}

/** On a server where companies are invited (decisions/0033), the code that
 *  lets a tenant's admin create their company; elsewhere, a plain invitation. */
let companiesInvited
async function companyCode(owner, company) {
  // Asked of the server, not read off the page: the console's sidebar draws a
  // moment after it opens, and a plain invitation in its place makes an admin
  // who can never create their company.
  companiesInvited ??= (await (await fetch(`${BASE}/api/instance`)).json()).companiesInvited === true
  if (!companiesInvited) return null
  await menu(owner, 'Admin')
  const tenants = owner.locator('.sidebar .side-item', { hasText: 'Tenants' })
  await tenants.waitFor({ timeout: 30_000 })
  await tenants.click()
  await owner.fill('input[aria-label="Company name"]', company)
  await owner.getByRole('button', { name: 'Create invitation' }).click()
  return (await owner.locator('.company-code .recovery-key code').innerText()).trim()
}

async function register(page, email, code) {
  for (;;) {
    // The invitation link opens the one-step sign-up (account password and
    // master password together): no emailed code to a .example address.
    await go(page, `${BASE}/app/?invite=${encodeURIComponent(code)}`)
    await page.waitForSelector('#r-email')
    await page.fill('#r-email', email)
    await page.fill('#r-account', DEMO_ACCOUNT_PASSWORD)
    await page.fill('#r-account-confirm', DEMO_ACCOUNT_PASSWORD)
    await page.fill('#r-password', DEMO_PASSWORD)
    await page.fill('#r-confirm', DEMO_PASSWORD)
    await page.click('button[type=submit]')
    const r = await Promise.race([
      page.waitForSelector('.recovery-key', { timeout: 90_000 }).then(() => 'ok'),
      page.waitForSelector('.alert-error', { timeout: 90_000 }).then(() => 'error'),
    ])
    if (r === 'ok') break
    const text = await page.locator('.alert-error').first().innerText()
    if (/could not be created/.test(text)) throw new Error(`${email}: ${text}`)
    if (!(await rateLimited(page))) throw new Error(`could not register ${email}: ${text}`)
  }
  await page.check('.check input')
  await page.getByRole('button', { name: 'Continue to sign in' }).click()
  await unlock(page, email, DEMO_PASSWORD)
}

/** A signed-in page for a demo account, registering it first if needed. */
async function person(owner, email, name, company) {
  if (pages.has(email)) return pages.get(email)
  const page = await newPage()
  if (state.accounts[email]) {
    await unlock(page, email, DEMO_PASSWORD)
  } else {
    const code = (company ? await companyCode(owner, company) : null) ?? await inviteCode(owner, `${name} (demo)`)
    try {
      await register(page, email, code)
    } catch (err) {
      // Made by a run that stopped before it could note it: sign in instead.
      if (!/could not be created/.test(String(err))) throw err
      log(`${email} already exists; signing in`)
      await unlock(page, email, DEMO_PASSWORD)
    }
    state.accounts[email] = { name, role: 'user' }
    save()
    log(`account ${email}`)
  }
  pages.set(email, page)
  return page
}

async function addItem(page, [name, username, url]) {
  await menu(page, 'Vault')
  await page.click('.topbar .btn-primary')
  await page.fill('#f-name', name)
  await page.fill('#f-username', username)
  await page.fill('#f-password', strong())
  await page.fill('#f-url', url)
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
}

/** Whether the vault list shows an item of this name. */
async function inVault(page, name) {
  await menu(page, 'Vault')
  await page.waitForSelector('.topbar')
  const all = page.locator('.sidebar .side-item', { hasText: 'All items' }).first()
  if (await all.count()) await all.click()
  await page.locator('.row-item').first().waitFor({ timeout: 5_000 }).catch(() => {})
  return (await page.locator('.row-item', { hasText: name }).count()) > 0
}

/** Whether an item of this name is in a collection ("Org / Collection"):
 *  its details carry the collection's badge. */
async function inCollection(page, name, where) {
  await menu(page, 'Vault')
  await page.waitForSelector('.topbar')
  const all = page.locator('.sidebar .side-item', { hasText: 'All items' }).first()
  if (await all.count()) await all.click()
  const row = page.locator('.row-item', { hasText: name }).first()
  if (!(await row.waitFor({ timeout: 8_000 }).then(() => true, () => false))) return false
  await row.click()
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
  return (await page.locator('.detail', { hasText: where }).count()) > 0
}

async function moveTo(page, itemName, where) {
  await menu(page, 'Vault')
  const all = page.locator('.sidebar .side-item', { hasText: 'All items' }).first()
  if (await all.count()) await all.click()
  await page.locator('.row-item', { hasText: itemName }).first().click()
  await page.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).click()
  await page.selectOption('select[aria-label="Collection"]', { label: where })
  // Done when the collection's count in the sidebar goes up.
  const collection = where.split(' / ').pop()
  const countOf = async () => {
    const side = page.locator('.sidebar .side-item', { hasText: collection })
    if (!(await side.count())) return 0
    return Number((await side.first().innerText()).match(/(\d+)\s*$/)?.[1] ?? 0)
  }
  const before = await countOf()
  await page.getByRole('button', { name: 'Move to collection' }).click()
  for (let i = 0; i < 60 && (await countOf()) <= before; i++) await page.waitForTimeout(500)
  if ((await countOf()) <= before) throw new Error(`${itemName} was not moved to ${where}`)
}

/** Sets what a grant allows: a permission set (decisions/0032) where the
 *  server has them, else the older permission and hide-passwords controls. */
async function chooseAccess(row, perm, hide) {
  const sets = row.locator('select[aria-label="Permission set"]')
  if (await sets.count()) {
    const label = perm === 'manage' ? 'Manager' : perm === 'edit' ? 'Editor' : hide ? 'Use only' : 'Viewer'
    await sets.selectOption({ label })
    return
  }
  await row.locator('select[aria-label="Permission"]').selectOption(perm)
  if (hide) await row.getByLabel('Hide passwords').check()
}

/** Opens Organizations afresh: by way of the vault, so the page mounts again
 *  and loads what changed (a member who just accepted, a new grant). */
async function orgsPage(page) {
  await menu(page, 'Vault')
  await page.waitForSelector('.topbar')
  await menu(page, 'Organizations')
  await page.waitForSelector('h1:has-text("rganizations")')
  await page.waitForSelector('.org-card, text=No organizations', { timeout: 30_000 }).catch(() => {})
}

/** Where an admin manages an organization: a section of the admin console
 *  (decisions/0031), or, on a server from before it, the Organizations page.
 *  Returns the card that holds that section's controls. */
async function manage(page, org, section, tries = 0) {
  const card = await openSection(page, org, section)
  // Fast clicking can pass the per-account request limit (300 a minute): the
  // page then says how long to wait. Wait that long and open it again.
  const wait = await cooldown(page)
  if (wait && tries < 5) {
    await page.waitForTimeout((wait + 2) * 1000)
    return manage(page, org, section, tries + 1)
  }
  await card.waitFor({ timeout: 30_000 })
  return card
}

/** Seconds the page asks us to wait, if it shows the rate-limit message. */
async function cooldown(page) {
  const alert = page.locator('text=/Too many attempts\\. Wait \\d+ seconds/').first()
  if (!(await alert.waitFor({ timeout: 2_000 }).then(() => true, () => false))) return 0
  return Number(/Wait (\d+) seconds/.exec(await alert.innerText())?.[1] ?? 30)
}

async function openSection(page, org, section) {
  await menu(page, 'Vault')
  await page.waitForSelector('.topbar')
  if (await page.locator('.workspace-switch').count()) {
    if (section === 'Members') section = 'People'
    await page.locator('.workspace-switch a', { hasText: 'Admin console' }).click()
    await page.waitForSelector('.console-layout')
    const picker = page.locator('select#scope')
    if (await picker.count()) await picker.selectOption({ label: org })
    await page.locator('.console-layout .sidebar .side-item', { hasText: section }).click()
    await page.waitForSelector(`.console-org h1:has-text("${section}")`)
  } else {
    await menu(page, 'Organizations')
    await page.waitForSelector('h1:has-text("Organizations")')
  }
  const card = page.locator(`.admin-main .org-card[aria-label="${org}"], main .org-card[aria-label="${org}"]`).first()
  await card.waitFor({ timeout: 15_000 }).catch(() => {})
  return card
}

/** Waits for a locator, reopening Organizations between tries. Fails loudly:
 *  a step that silently did nothing would leave a half-made company. */
async function appear(page, locator, what, reopen = () => orgsPage(page)) {
  for (let i = 0; i < 4; i++) {
    if (await locator.count()) return
    await page.waitForTimeout(1500)
    if (await locator.count()) return
    await reopen()
  }
  throw new Error(`never appeared: ${what}`)
}

// ── Run ─────────────────────────────────────────────────────────────────────

try {
  const owner = await newPage()
  await unlock(owner, OWNER_EMAIL, OWNER_PASSWORD)
  log('owner signed in')

  for (const p of PERSONAL) {
    if (state.accounts[p.email]?.items) continue
    const page = await person(owner, p.email, p.name)
    for (const it of p.items) await addItem(page, it)
    state.accounts[p.email].items = true; save()
    // One page per person would be fifty browsers; close what is done.
    await page.context().close(); pages.delete(p.email)
  }

  for (const t of TENANTS) {
    const done = state.tenants[t.org] ?? {}
    const admin = await person(owner, t.admin.email, t.admin.name, t.org)
    for (const m of t.members) await person(owner, m.email, m.name)
    if (done.complete && done.members === t.members.length) { log(`${t.org}: already set up`); for (const m of [t.admin, ...t.members]) { await pages.get(m.email)?.context().close(); pages.delete(m.email) } continue }

    // The company, its recovery key, collections and groups.
    await orgsPage(admin)
    if (!done.created) {
      if (!(await admin.locator('#o-name').waitFor({ timeout: 20_000 }).then(() => true, () => false))) {
        throw new Error(`${t.admin.email} cannot create ${t.org}: the account was made without a company invitation. Delete it in the console and run again.`)
      }
      await admin.fill('#o-name', t.org)
      await admin.getByRole('button', { name: 'Create', exact: true }).click()
      await admin.waitForSelector('#ork-title')
      done.recoveryKey = (await admin.locator('.modal .recovery-key code').innerText()).trim()
      await admin.getByLabel('I have stored it somewhere safe').check()
      await admin.getByRole('button', { name: 'Done' }).click()
      await admin.locator('.org-card h2', { hasText: t.org }).first().waitFor()
      done.created = true
      state.tenants[t.org] = done; save()
      log(`${t.org}: created`)
    }
    let card = await manage(admin, t.org, 'Collections')
    for (const c of t.collections) {
      if (await card.locator('.collection-row', { hasText: c.name }).count()) continue
      await card.locator('input[aria-label="New collection name"]').fill(c.name)
      await card.getByRole('button', { name: 'Add collection' }).click()
      await card.locator('.collection-row', { hasText: c.name }).waitFor()
    }

    // Members: invited, accepted, confirmed by fingerprint.
    card = await manage(admin, t.org, 'Members')
    for (const m of t.members) {
      if (await card.locator('.device-row:not(.group-row)', { hasText: m.name }).count()) continue
      await card.locator('input[aria-label="Email to invite"]').fill(m.email)
      await card.locator('input[aria-label="Name for this member"]').fill(m.name)
      await card.getByRole('button', { name: 'Invite', exact: true }).click()
      await card.locator('.device-row:not(.group-row)', { hasText: m.name }).waitFor()
    }
    for (const m of t.members) {
      const page = pages.get(m.email)
      await orgsPage(page)
      // Only the invitations card's button: nothing else on the page is "Accept".
      const accept = page.locator('section:has(#o-inv)').getByRole('button', { name: 'Accept', exact: true })
      const joined = page.locator('.org-card', { hasText: t.org })
      await appear(page, accept.or(joined), `${m.email}: the invitation to ${t.org}`)
      if (await accept.count()) { await accept.first().click(); await page.waitForSelector('text=An admin must confirm you') }
    }
    const members = () => manage(admin, t.org, 'Members')
    card = await members()
    for (const m of t.members) {
      const row = card.locator('.device-row:not(.group-row)', { hasText: m.name })
      const confirm = row.getByRole('button', { name: 'Confirm…' })
      const pending = row.locator('text=has not joined yet')
      await appear(admin, row, `${m.name} in ${t.org}`, members)
      for (let i = 0; i < 4 && await pending.count(); i++) await members()
      if (!(await confirm.count())) continue // already confirmed
      await confirm.click()
      await admin.getByRole('button', { name: 'It matches — confirm' }).click()
      await admin.waitForSelector(`text=${m.name} confirmed`, { state: 'attached' })
    }

    // Groups.
    if (t.groups.length) card = await manage(admin, t.org, 'Groups')
    for (const g of t.groups) {
      if (!(await card.locator('li', { hasText: g.name }).locator(`select[aria-label="Add to ${g.name}"]`).count())) {
        await card.locator('input[aria-label="New group name"]').fill(g.name)
        await card.getByRole('button', { name: 'Add group' }).click()
        await card.locator(`select[aria-label="Add to ${g.name}"]`).waitFor()
      }
      for (const email of g.members) {
        const label = t.members.find((m) => m.email === email)?.name
        const sel = card.locator(`select[aria-label="Add to ${g.name}"]`)
        const already = card.locator('li', { hasText: g.name }).locator('.chip, span', { hasText: label })
        if (!(await sel.locator('option', { hasText: label }).count())) {
          if (await already.count()) continue
          throw new Error(`${label} cannot be added to ${g.name}: not confirmed?`)
        }
        await sel.selectOption({ label })
        await sel.locator('xpath=..').getByRole('button', { name: 'Add' }).click()
        await admin.waitForSelector(`text=${label} added`, { state: 'attached' })
      }
    }

    // Access to collections, by group or by person.
    const collections = () => manage(admin, t.org, 'Collections')
    card = await collections()
    for (const c of t.collections) {
      const row = card.locator('.collection-row', { hasText: c.name })
      await row.getByRole('button', { name: 'Access' }).click()
      if (c.group) {
        const g = row.locator('select[aria-label="Group"]')
        await appear(admin, g.locator('option', { hasText: c.group }), `group ${c.group} in the access list of ${c.name}`,
          async () => { await collections(); await row.getByRole('button', { name: 'Access' }).click() })
        {
          // The permission select is shared by the person and group forms.
          await chooseAccess(row, c.perm ?? 'view', false)
          await g.selectOption({ label: c.group })
          await row.getByRole('button', { name: 'Share with group' }).click()
          await admin.waitForSelector('text=Group given access', { state: 'attached' })
        }
      }
      for (const p of c.people ?? []) {
        const label = t.members.find((m) => m.email === p.email)?.name
        const who = row.locator('select[aria-label="Member"]')
        // The dialog loads its members and grants a moment after it opens.
        await who.locator('option', { hasText: label }).or(row.locator('.access-list li', { hasText: label })).first().waitFor({ timeout: 15_000 }).catch(() => {})
        if (!(await who.locator('option', { hasText: label }).count())) {
          if (await row.locator('.access-list li', { hasText: label }).count()) continue
          throw new Error(`${label} cannot be given ${c.name}: not confirmed?`)
        }
        await who.selectOption({ label })
        await chooseAccess(row, p.perm, !!p.hide)
        await row.getByRole('button', { name: 'Share', exact: true }).click()
        await row.locator('.access-list li', { hasText: label }).waitFor()
      }
    }

    // Items: the admin's own, and shared ones moved into each collection
    // (once: a re-run that adds members does not add them again).
    // A company set up by an earlier version of this script already has its
    // admin's items and, at Acme, the Finance collection's.
    // What is there already is looked up, not assumed: a run that stopped
    // half way, or a company made by an earlier version of this script.
    done.coll ??= {}
    if (!done.adminItems) {
      for (const it of t.items) if (!(await inVault(admin, it[0]))) await addItem(admin, it)
      done.adminItems = true; state.tenants[t.org] = done; save()
    }
    for (const c of t.collections) {
      if (done.coll[c.name]) continue
      for (const it of c.items) {
        if (await inCollection(admin, it[0], `${t.org} / ${c.name}`)) continue
        if (!(await inVault(admin, it[0]))) await addItem(admin, it)
        await moveTo(admin, it[0], `${t.org} / ${c.name}`)
      }
      done.coll[c.name] = true; state.tenants[t.org] = done; save()
    }
    // Check: each member opens at least one item shared with them.
    for (const c of t.collections) {
      const readers = [...(c.people ?? []).map((p) => p.email), ...(t.groups.find((g) => g.name === c.group)?.members ?? [])]
      for (const email of readers) {
        const page = pages.get(email)
        await orgsPage(page)
        await menu(page, 'Vault')
        await appear(page, page.locator('.row-item', { hasText: c.items[0][0] }), `${email} sees ${c.items[0][0]}`)
      }
    }
    done.complete = true
    done.members = t.members.length
    state.tenants[t.org] = done; save()
    log(`${t.org}: complete`)
    for (const m of [t.admin, ...t.members]) { await pages.get(m.email)?.context().close(); pages.delete(m.email) }
  }
  log(`done. Accounts and organization recovery keys: ${OUT}`)
} catch (err) {
  // DEMO_SHOTS=<dir>: a screenshot of every open page, to see where it stopped.
  if (process.env.DEMO_SHOTS) {
    let i = 0
    for (const [email, page] of pages) await page.screenshot({ path: `${process.env.DEMO_SHOTS}/fail-${++i}-${email.split('@')[0]}.png`, fullPage: true }).catch(() => {})
  }
  throw err
} finally {
  await browser.close()
}
