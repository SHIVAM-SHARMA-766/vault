// Website editing: drafts, validation, publishing to disk, rollback, images,
// and the escaping that keeps editors from putting markup on this origin.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fixtureB64, harness, registration } from './harness.js'

const OWNER = 'owner@example.com'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])

async function setup() {
  const out = await mkdtemp(join(tmpdir(), 'vault-site-'))
  const h = harness({ adminEmails: [OWNER], allowRegistration: true, siteOutput: out })
  const reg = async (email: string) => {
    const r = await h.request('POST', '/api/auth/register', { body: registration({ email, authKey: fixtureB64(email) }) })
    return { id: String(r.body['userId']), token: String(r.body['accessToken']) }
  }
  const owner = await reg(OWNER)
  const marketing = await reg('marketing@example.com')
  const viewer = await reg('viewer@example.com')
  await h.request('PUT', `/api/admin/users/${marketing.id}/role`, { token: owner.token, body: { role: 'marketing' } })
  await h.request('PUT', `/api/admin/users/${viewer.id}/role`, { token: owner.token, body: { role: 'viewer' } })
  const site = (await h.request('GET', '/api/admin/site', { token: marketing.token })).body
  const content = structuredClone((site['live'] as { content: Record<string, Record<string, Record<string, unknown>>> }).content)
  return { h, out, owner, marketing, viewer, content }
}

const live = async (out: string, page = 'index.html') => readFile(join(out, 'current', page), 'utf8')

test('marketing can save, publish, and the live site changes', async () => {
  const { h, out, marketing, content } = await setup()
  content['home']!['hero']!['titleAccent'] = 'never reads'
  assert.equal((await h.request('PUT', '/api/admin/site/draft', { token: marketing.token, body: { content } })).status, 200)
  const pub = await h.request('POST', '/api/admin/site/publish', { token: marketing.token, body: { note: 'new headline' } })
  assert.equal(pub.status, 200)
  assert.match(await live(out), /never reads/)
  assert.ok((await readlink(join(out, 'current'))).startsWith('v-'))
  // the static assets travel with each render
  assert.ok((await readdir(join(out, 'current'))).includes('site.css'))
})

test('a viewer can read the editor but change nothing', async () => {
  const { h, viewer, content } = await setup()
  assert.equal((await h.request('GET', '/api/admin/site', { token: viewer.token })).status, 200)
  assert.equal((await h.request('PUT', '/api/admin/site/draft', { token: viewer.token, body: { content } })).status, 403)
  assert.equal((await h.request('POST', '/api/admin/site/publish', { token: viewer.token, body: {} })).status, 403)
})

test('markup typed into a field is shown as text, never run', async () => {
  const { h, out, marketing, content } = await setup()
  content['home']!['hero']!['titleStart'] = '<script>alert(1)</script><img src=x onerror=alert(1)>'
  await h.request('PUT', '/api/admin/site/draft', { token: marketing.token, body: { content } })
  await h.request('POST', '/api/admin/site/publish', { token: marketing.token, body: {} })
  const html = await live(out)
  assert.ok(!html.includes('<script>alert'))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
})

test('a dangerous link is refused, not rendered', async () => {
  const { h, marketing, content } = await setup()
  content['global']!['banner'] = { enabled: true, text: 'Hi', linkText: 'Go', linkHref: 'javascript:alert(1)', tone: 'info' }
  const res = await h.request('PUT', '/api/admin/site/draft', { token: marketing.token, body: { content } })
  assert.equal(res.status, 400)
  assert.ok(JSON.stringify(res.body['details']).includes('global.banner.linkHref'))
})

test('limits are enforced field by field', async () => {
  const { h, marketing, content } = await setup()
  content['home']!['seo']!['title'] = 'x'.repeat(200)
  const res = await h.request('PUT', '/api/admin/site/draft', { token: marketing.token, body: { content } })
  assert.equal(res.status, 400)
  assert.ok((res.body['details'] as Array<{ path: string }>).some((d) => d.path === 'home.seo.title'))
})

test('rolling back restores an earlier version', async () => {
  const { h, out, owner, content } = await setup()
  content['faq']!['hero']!['title'] = 'First wording'
  await h.request('PUT', '/api/admin/site/draft', { token: owner.token, body: { content } })
  const first = String((await h.request('POST', '/api/admin/site/publish', { token: owner.token, body: {} })).body['version'])
  content['faq']!['hero']!['title'] = 'Second wording'
  await h.request('PUT', '/api/admin/site/draft', { token: owner.token, body: { content } })
  await h.request('POST', '/api/admin/site/publish', { token: owner.token, body: {} })
  assert.match(await live(out, 'faq.html'), /Second wording/)
  assert.equal((await h.request('POST', `/api/admin/site/rollback/${first}`, { token: owner.token })).status, 200)
  assert.match(await live(out, 'faq.html'), /First wording/)
})

test('images: only real PNG, JPEG or WebP, used by id, and protected while in use', async () => {
  const { h, out, marketing, content } = await setup()
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  assert.equal((await h.request('POST', '/api/admin/media', { token: marketing.token, body: { name: 'x.png', data: svg.toString('base64') } })).status, 400)

  const up = await h.request('POST', '/api/admin/media', { token: marketing.token, body: { name: 'hero.png', data: PNG.toString('base64') } })
  assert.equal(up.status, 201)
  const id = String((up.body['media'] as { id: string }).id)
  assert.ok((await readdir(join(out, 'media'))).includes(`${id}.png`))

  content['home']!['hero']!['image'] = id
  await h.request('PUT', '/api/admin/site/draft', { token: marketing.token, body: { content } })
  await h.request('POST', '/api/admin/site/publish', { token: marketing.token, body: {} })
  assert.match(await live(out), new RegExp(`/media/${id}\\.png`))

  assert.equal((await h.request('DELETE', `/api/admin/media/${id}`, { token: marketing.token })).status, 409)

  content['home']!['hero']!['image'] = 'm_doesnotexist000000000'
  const bad = await h.request('PUT', '/api/admin/site/draft', { token: marketing.token, body: { content } })
  assert.equal(bad.status, 400)
})

test('preview renders without publishing', async () => {
  const { h, out, marketing, content } = await setup()
  const before = await live(out).catch(() => null)
  content['home']!['hero']!['titleEnd'] = 'preview only.'
  const res = await h.request('POST', '/api/admin/site/preview', { token: marketing.token, body: { content, page: 'index.html' } })
  assert.equal(res.status, 200)
  assert.match(String(res.body['html']), /preview only\./)
  assert.match(String(res.body['html']), /href="https:\/\/vault\.test\/site\.css"/)
  assert.equal(await live(out).catch(() => null), before)
})

test('publishing is audited', async () => {
  const { h, owner, marketing, content } = await setup()
  await h.request('PUT', '/api/admin/site/draft', { token: marketing.token, body: { content } })
  await h.request('POST', '/api/admin/site/publish', { token: marketing.token, body: { note: 'launch copy' } })
  const records = (await h.request('GET', '/api/admin/audit', { token: owner.token })).body['records'] as Array<Record<string, unknown>>
  assert.ok(records.some((r) => r['action'] === 'site.publish' && r['detail'] === 'launch copy'))
})

test('the "Run your own" page is published with the install command, and a site saved before it existed still gets it', async () => {
  const { h, out, owner, content } = await setup()
  content['get']!['install']!['command'] = 'curl -fsSL https://example.org/install.sh | sh'
  await h.request('PUT', '/api/admin/site/draft', { token: owner.token, body: { content } })
  await h.request('POST', '/api/admin/site/publish', { token: owner.token, body: {} })
  const page = await live(out, 'get.html')
  assert.match(page, /curl -fsSL https:\/\/example\.org\/install\.sh \| sh/)
  assert.match(page, /aria-current="page">Run your own</)

  // Content from before the page existed: the defaults fill it in.
  const { get: _get, ...older } = content
  await h.request('PUT', '/api/admin/site/draft', { token: owner.token, body: { content: older } })
  assert.equal((await h.request('POST', '/api/admin/site/publish', { token: owner.token, body: {} })).status, 200)
  assert.match(await live(out, 'get.html'), /deploy\/install\.sh \| sh/)
})
