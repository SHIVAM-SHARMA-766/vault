// Performance check for the improvement pass: a 5,000-item vault, unlocked
// on a CPU slowed to roughly a mid-range phone (4x throttle).
//
//   npm run build && node scripts/bench.mjs [items] [throttle]
//
// Prints how long unlock takes (from pressing Unlock to the list showing the
// full count) and how long a search takes. Target (docs/ROADMAP.md, phase
// 3.5): unlock under two seconds.

import { start, PASSWORD } from '../tests/e2e/helpers.mjs'

const N = Number(process.argv[2] ?? 5000)
const THROTTLE = Number(process.argv[3] ?? 4)
const rows = ['name,url,username,password,note']
for (let i = 0; i < N; i++) rows.push(`Site ${String(i).padStart(5, '0')},https://site${i}.example.com,user${i}@example.com,P@ss-${i}-${Math.random().toString(36).slice(2, 12)},note ${i}`)

const s = await start()
try {
  const page = await s.person()
  await s.register(page, 'bench@example.test')
  await s.menu(page, 'Import & export')
  await page.setInputFiles('.file-drop input', { name: 'chrome.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) })
  await page.getByRole('button', { name: /^Import \d+ items/ }).click()
  await page.waitForSelector('.alert-ok', { timeout: 600_000 })
  console.log('imported:', await page.textContent('.alert-ok'))

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
  // Unlock on the vault page (a reload keeps the current address).
  await page.goto(`${s.base}/app/`)
  await page.fill('#email', 'bench@example.test')
  await page.fill('#password', PASSWORD)
  const t0 = Date.now()
  await page.click('button[type=submit]')
  await page.waitForSelector('.topbar', { timeout: 120_000 })
  const tShell = Date.now()
  await page.waitForFunction((n) => document.querySelector('.list-head .muted')?.textContent === String(n), N, { timeout: 300_000 })
    .catch(async (err) => { console.log('count seen:', await page.textContent('.list-head .muted').catch(() => '?'), await page.locator('.alert').allInnerTexts()); throw err })
  const tList = Date.now()
  await page.fill('input[type=search]', `Site ${String(N - 1).padStart(5, '0')}`)
  const t2 = Date.now()
  await page.waitForFunction(() => document.querySelector('.list-head .muted')?.textContent === '1', null, { timeout: 60_000 })
  const tSearch = Date.now() - t2
  console.log(JSON.stringify({ items: N, throttle: THROTTLE, keyDerivationAndSignInMs: tShell - t0, vaultReadyMs: tList - tShell, unlockTotalMs: tList - t0, searchMs: tSearch }))
} finally {
  await s.stop()
}
