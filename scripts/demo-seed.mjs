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
const OUT = process.env.DEMO_OUT ?? 'demo-accounts.json'
if (!BASE || !OWNER_EMAIL || !OWNER_PASSWORD || !DEMO_PASSWORD) {
  console.error('Set BASE, OWNER_EMAIL, OWNER_PASSWORD and DEMO_PASSWORD.')
  process.exit(2)
}

// ── Who ─────────────────────────────────────────────────────────────────────

const PERSONAL = [
  { email: 'priya@personal.example', name: 'Priya', items: [['Gmail', 'priya@gmail.example', 'https://mail.google.com'], ['Netflix', 'priya.s', 'https://netflix.com'], ['HDFC NetBanking', 'priya1990', 'https://netbanking.hdfcbank.com']] },
  { email: 'rahul@personal.example', name: 'Rahul', items: [['GitHub', 'rahul-dev', 'https://github.com'], ['Amazon', 'rahul@mail.example', 'https://amazon.in']] },
]

const TENANTS = [
  {
    org: 'Acme Corp',
    admin: { email: 'anita@acme.example', name: 'Anita (admin)' },
    members: [{ email: 'ben@acme.example', name: 'Ben' }, { email: 'chen@acme.example', name: 'Chen' }],
    groups: [{ name: 'Engineering', members: ['ben@acme.example', 'chen@acme.example'] }],
    collections: [
      { name: 'Engineering', group: 'Engineering', perm: 'edit', items: [['AWS console', 'acme-ops', 'https://console.aws.amazon.com'], ['Grafana', 'admin', 'https://grafana.acme.example']] },
      { name: 'Finance', people: [{ email: 'chen@acme.example', perm: 'view', hide: true }], items: [['Payroll portal', 'payroll@acme.example', 'https://payroll.acme.example']] },
    ],
    items: [['Acme Slack', 'anita@acme.example', 'https://acme.slack.com']],
  },
  {
    org: 'Globex',
    admin: { email: 'gita@globex.example', name: 'Gita (admin)' },
    members: [{ email: 'hari@globex.example', name: 'Hari' }],
    groups: [],
    collections: [
      { name: 'Operations', people: [{ email: 'hari@globex.example', perm: 'edit' }], items: [['Router admin', 'admin', 'https://192.168.1.1'], ['Office Wi-Fi portal', 'globex', 'https://wifi.globex.example']] },
    ],
    items: [],
  },
]

// ── State ───────────────────────────────────────────────────────────────────

const state = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { server: BASE, accounts: {}, tenants: {} }
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
  if (!/Too many attempts/.test(text)) throw new Error(text)
  const minutes = m ? Number(m[1]) : 15
  log(`rate limited; waiting ${minutes} min`)
  await sleep(minutes * 60_000 + 10_000)
  return true
}

async function unlock(page, email, password) {
  for (;;) {
    await go(page, `${BASE}/app/`)
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.click('button[type=submit]')
    const r = await Promise.race([
      page.waitForSelector('.topbar', { timeout: 90_000 }).then(() => 'ok'),
      page.waitForSelector('.alert-error', { timeout: 90_000 }).then(() => 'error'),
    ])
    if (r === 'ok') return
    if (!(await rateLimited(page))) return
  }
}

async function menu(page, item) {
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

async function register(page, email, code) {
  for (;;) {
    await go(page, `${BASE}/app/`)
    await page.getByRole('button', { name: 'Create an account' }).first().click()
    await page.waitForSelector('#r-invite, button:has-text("I have an invitation code")')
    if (!(await page.locator('#r-invite').count())) await page.getByRole('button', { name: 'I have an invitation code' }).click()
    await page.fill('#r-invite', code)
    await page.fill('#r-email', email)
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
    if (!(await rateLimited(page))) throw new Error(`could not register ${email}`)
  }
  await page.check('.check input')
  await page.getByRole('button', { name: 'Continue to sign in' }).click()
  await unlock(page, email, DEMO_PASSWORD)
}

/** A signed-in page for a demo account, registering it first if needed. */
async function person(owner, email, name) {
  if (pages.has(email)) return pages.get(email)
  const page = await newPage()
  if (state.accounts[email]) {
    await unlock(page, email, DEMO_PASSWORD)
  } else {
    const code = await inviteCode(owner, `${name} (demo)`)
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

async function moveTo(page, itemName, where) {
  await menu(page, 'Vault')
  await page.locator('.row-item', { hasText: itemName }).first().click()
  await page.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).click()
  await page.selectOption('select[aria-label="Collection"]', { label: where })
  await page.getByRole('button', { name: 'Move to collection' }).click()
  await page.waitForSelector(`.badge-shared:has-text("${where}")`)
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
async function manage(page, org, section) {
  await menu(page, 'Vault')
  await page.waitForSelector('.topbar')
  if (await page.locator('.workspace-switch').count()) {
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
  const card = page.locator('.admin-main .org-card, main .org-card').filter({ hasText: org }).first()
  await card.waitFor({ timeout: 30_000 })
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
    const fresh = !state.accounts[p.email]
    const page = await person(owner, p.email, p.name)
    if (fresh) for (const it of p.items) await addItem(page, it)
  }

  for (const t of TENANTS) {
    const done = state.tenants[t.org] ?? {}
    const admin = await person(owner, t.admin.email, t.admin.name)
    for (const m of t.members) await person(owner, m.email, m.name)
    if (done.complete) { log(`${t.org}: already set up`); continue }

    // The company, its recovery key, collections and groups.
    await orgsPage(admin)
    if (!done.created) {
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
      if (await card.locator('.device-row', { hasText: m.name }).count()) continue
      await card.locator('input[aria-label="Email to invite"]').fill(m.email)
      await card.locator('input[aria-label="Name for this member"]').fill(m.name)
      await card.getByRole('button', { name: 'Invite', exact: true }).click()
      await card.locator('.device-row', { hasText: m.name }).waitFor()
    }
    for (const m of t.members) {
      const page = pages.get(m.email)
      await orgsPage(page)
      const accept = page.getByRole('button', { name: 'Accept' })
      const joined = page.locator('.org-card', { hasText: t.org })
      await appear(page, accept.or(joined), `${m.email}: the invitation to ${t.org}`)
      if (await accept.count()) { await accept.first().click(); await page.waitForSelector('text=An admin must confirm you') }
    }
    const members = () => manage(admin, t.org, 'Members')
    card = await members()
    for (const m of t.members) {
      const row = card.locator('.device-row', { hasText: m.name })
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
          await row.locator('select[aria-label="Permission"]').selectOption(c.perm ?? 'view')
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
        await row.locator('select[aria-label="Permission"]').selectOption(p.perm)
        if (p.hide) await row.getByLabel('Hide passwords').check()
        await row.getByRole('button', { name: 'Share', exact: true }).click()
        await row.locator('.access-list li', { hasText: label }).waitFor()
      }
    }

    // Items: the admin's own, and shared ones moved into each collection.
    for (const it of t.items) await addItem(admin, it)
    for (const c of t.collections) {
      for (const it of c.items) {
        await addItem(admin, it)
        await moveTo(admin, it[0], `${t.org} / ${c.name}`)
      }
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
    state.tenants[t.org] = done; save()
    log(`${t.org}: complete`)
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
