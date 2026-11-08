// Renders icons/icon.svg to the PNG sizes the manifests list. Run once after
// changing the SVG and commit the PNGs:  node apps/extension/scripts/icons.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const dir = new URL('../icons/', import.meta.url)
const svg = readFileSync(new URL('icon.svg', dir), 'utf8')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium' })
const page = await browser.newPage()
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`)
  writeFileSync(new URL(`icon-${size}.png`, dir), await page.screenshot({ omitBackground: true }))
}
await browser.close()
console.log('icons written')
