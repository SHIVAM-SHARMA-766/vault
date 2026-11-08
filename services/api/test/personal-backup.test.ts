// Personal backups (decisions/0017): the schedule, the file, sealed
// destination secrets, retention, the timer, and real deliveries to local
// WebDAV and S3 stand-ins.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { nextRun, openSecret, runBackup, sealSecret, tick, type Schedule } from '../src/personal-backup.js'
import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const T = (iso: string) => Date.parse(iso)
const S = (over: Partial<Schedule>): Schedule => ({ frequency: 'daily', hour: 2, weekday: 0, tzOffsetMinutes: 0, keep: 7, ...over })

test('daily: later today if the hour is still ahead, else tomorrow', () => {
  assert.equal(nextRun(S({}), T('2026-11-07T01:00:00Z')), T('2026-11-07T02:00:00Z'))
  assert.equal(nextRun(S({}), T('2026-11-07T02:00:00Z')), T('2026-11-08T02:00:00Z'))
  assert.equal(nextRun(S({}), T('2026-11-07T23:00:00Z')), T('2026-11-08T02:00:00Z'))
})

test('the hour is local: 02:00 in India is 20:30 UTC the day before', () => {
  const ist = S({ tzOffsetMinutes: 330 })
  assert.equal(nextRun(ist, T('2026-11-07T12:00:00Z')), T('2026-11-07T20:30:00Z'))
  assert.equal(nextRun(ist, T('2026-11-07T21:00:00Z')), T('2026-11-08T20:30:00Z'))
})

test('weekly on the chosen weekday; monthly on the 1st, across the year end', () => {
  // 2026-11-07 is a Saturday.
  assert.equal(nextRun(S({ frequency: 'weekly', weekday: 1 }), T('2026-11-07T12:00:00Z')), T('2026-11-09T02:00:00Z'))
  assert.equal(nextRun(S({ frequency: 'weekly', weekday: 6 }), T('2026-11-07T12:00:00Z')), T('2026-11-14T02:00:00Z'))
  assert.equal(nextRun(S({ frequency: 'weekly', weekday: 6 }), T('2026-11-07T01:00:00Z')), T('2026-11-07T02:00:00Z'))
  assert.equal(nextRun(S({ frequency: 'monthly' }), T('2026-12-15T00:00:00Z')), T('2027-01-01T02:00:00Z'))
  assert.equal(nextRun(S({ frequency: 'off' }), T('2026-12-15T00:00:00Z')), null)
})

test('destination secrets are sealed, and bound to their account', () => {
  const sealed = sealSecret('pepper', 'user-a', 'top secret')
  assert.ok(!sealed.includes('top secret'))
  assert.equal(openSecret('pepper', 'user-a', sealed), 'top secret')
  assert.throws(() => openSecret('pepper', 'user-b', sealed))
  assert.throws(() => openSecret('other-pepper', 'user-a', sealed))
})

async function account(options: Parameters<typeof harness>[0] = {}) {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true, ...options })
  const owner = await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })
  const reg = registration()
  const me = await h.request('POST', '/api/auth/register', { body: reg })
  const other = await h.request('POST', '/api/auth/register', { body: registration({ email: 'other@example.com', authKey: fixtureB64('other') }) })
  const token = String(me.body['accessToken'])
  await h.request('PUT', '/api/vault/entries/entry-0001', { token, body: { blob: sealedBlob('e1') } })
  await h.request('PUT', '/api/vault/folders/folder-0001', { token, body: { blob: sealedBlob('f1') } })
  return { h, reg, token, userId: String(me.body['userId']), other: String(other.body['accessToken']), owner: String(owner.body['accessToken']) }
}

const SERVER_DAILY = { schedule: { frequency: 'daily', hour: 2, weekday: 0, tzOffsetMinutes: 330, keep: 2 }, destination: { type: 'server' } }

test('nothing set: off, kept on the server', async () => {
  const { h, token } = await account()
  const res = await h.request('GET', '/api/backups', { token })
  assert.equal(res.status, 200)
  assert.equal((res.body['schedule'] as Schedule).frequency, 'off')
  assert.deepEqual(res.body['destination'], { type: 'server' })
  assert.equal(res.body['nextRunAt'], null)
  assert.equal((await h.request('GET', '/api/backups')).status, 401)
})

test('back up now: the file opens with the keys the account had, and holds nothing else', async () => {
  const { h, reg, token } = await account()
  const run = await h.request('POST', '/api/backups/run', { token })
  assert.equal(run.status, 200)
  assert.equal((run.body['run'] as Record<string, unknown>)['entries'], 1)
  const list = await h.request('GET', '/api/backups', { token })
  const copies = list.body['copies'] as Array<Record<string, unknown>>
  assert.equal(copies.length, 1)
  assert.match(String(copies[0]!['name']), /^vault-backup-\d{8}-\d{6}\.json$/)
  const copy = await h.request('GET', `/api/backups/copies/${copies[0]!['id']}`, { token })
  const file = JSON.parse(String(copy.body['body']))
  assert.equal(file.format, 'vault-personal-backup')
  assert.deepEqual(file.kdf, reg['kdf'])
  assert.equal(file.wrappedVaultKey, reg['wrappedVaultKey'])
  assert.equal(file.recovery.wrappedVaultKey, reg['wrappedVaultKeyForRecovery'])
  assert.deepEqual(file.entries, [{ id: 'entry-0001', blob: sealedBlob('e1') }])
  assert.deepEqual(file.folders, [{ id: 'folder-0001', blob: sealedBlob('f1') }])
  const text = JSON.stringify(file)
  for (const leak of ['authVerifier', 'person@example.com', 'recoveryAuth', 'emailDigest', 'refresh']) assert.ok(!text.includes(leak), leak)
})

test('a copy belongs to its account', async () => {
  const { h, token, other } = await account()
  await h.request('POST', '/api/backups/run', { token })
  const id = ((await h.request('GET', '/api/backups', { token })).body['copies'] as Array<Record<string, unknown>>)[0]!['id']
  assert.equal((await h.request('GET', `/api/backups/copies/${id}`, { token: other })).status, 404)
  assert.equal((await h.request('DELETE', `/api/backups/copies/${id}`, { token: other })).status, 404)
  assert.equal((await h.request('DELETE', `/api/backups/copies/${id}`, { token })).status, 200)
  assert.equal(((await h.request('GET', '/api/backups', { token })).body['copies'] as unknown[]).length, 0)
})

test('only the newest copies are kept, and the history records each run', async () => {
  const { h, token } = await account()
  await h.request('PUT', '/api/backups/config', { token, body: SERVER_DAILY })
  for (let i = 0; i < 3; i++) {
    h.setNow(Date.UTC(2026, 8, 22, 12, i, 0))
    await h.request('POST', '/api/backups/run', { token })
  }
  const list = await h.request('GET', '/api/backups', { token })
  assert.equal((list.body['copies'] as unknown[]).length, 2)
  assert.equal((list.body['runs'] as unknown[]).length, 3)
})

test('a schedule falls due, the timer runs it, and the next run moves on', async () => {
  const a = await account()
  const { h, userId } = a
  let token = a.token
  const saved = await h.request('PUT', '/api/backups/config', { token, body: SERVER_DAILY })
  // Now is 2026-09-22 12:00 UTC = 17:30 IST; 02:00 IST next is 2026-09-22 20:30 UTC.
  assert.equal(saved.body['nextRunAt'], '2026-09-22T20:30:00.000Z')
  assert.ok(h.store.dump().some((i) => i.sk === `BKDUE#${userId}`))
  assert.equal(await tick(h.app), 0)
  h.setNow(Date.parse('2026-09-22T20:31:00Z'))
  assert.equal(await tick(h.app), 1)
  // Hours later, the morning's access token has expired: sign in again.
  const again = await h.request('POST', '/api/auth/login', { body: { email: 'person@example.com', authKey: fixtureB64('auth-key') } })
  token = String(again.body['accessToken'])
  const after = await h.request('GET', '/api/backups', { token })
  assert.equal(after.body['nextRunAt'], '2026-09-23T20:30:00.000Z')
  assert.equal(((after.body['runs'] as Array<Record<string, unknown>>)[0]!)['reason'], 'scheduled')
  assert.equal(await tick(h.app), 0, 'not twice')

  await h.request('PUT', '/api/backups/config', { token, body: { ...SERVER_DAILY, schedule: { ...SERVER_DAILY.schedule, frequency: 'off' } } })
  assert.ok(!h.store.dump().some((i) => i.sk === `BKDUE#${userId}`))
})

test('deleting the account removes its schedule and copies', async () => {
  const { h, token, userId, owner } = await account()
  await h.request('PUT', '/api/backups/config', { token, body: SERVER_DAILY })
  await h.request('POST', '/api/backups/run', { token })
  await h.request('POST', `/api/admin/users/${userId}/delete`, { token: owner, body: { confirm: userId } })
  assert.ok(!h.store.dump().some((i) => i.sk === `BKDUE#${userId}` || (i.pk === `USER#${userId}`)))
  h.setNow(Date.parse('2026-09-23T00:00:00Z'))
  assert.equal(await tick(h.app), 0)
})

test('bad schedules and destinations are refused', async () => {
  const { h, token } = await account()
  const put = (body: unknown) => h.request('PUT', '/api/backups/config', { token, body })
  const s = SERVER_DAILY.schedule
  for (const schedule of [{ ...s, frequency: 'hourly' }, { ...s, hour: 24 }, { ...s, keep: 0 }, { ...s, keep: 31 }, { ...s, tzOffsetMinutes: 900 }, { ...s, hour: 1.5 }]) {
    assert.equal((await put({ schedule, destination: { type: 'server' } })).status, 400, JSON.stringify(schedule))
  }
  const s3 = { type: 's3', endpoint: 'https://s3.example.com', region: 'eu-1', bucket: 'my-bucket', prefix: 'vault', accessKey: 'AK', secretKey: 'SK' }
  for (const destination of [
    { ...s3, endpoint: 'http://s3.example.com' },
    { ...s3, endpoint: 'https://169.254.169.254' },
    { ...s3, endpoint: 'https://127.0.0.1:9000' },
    { ...s3, bucket: 'Bad_Bucket' },
    { ...s3, prefix: '../etc' },
    { ...s3, secretKey: undefined },
    { type: 'webdav', url: 'https://me:pw@dav.example.com/', username: 'me', password: 'pw' },
    { type: 'webdav', url: 'https://dav.example.com/', username: '', password: 'pw' },
    { type: 'ftp' },
  ]) {
    assert.equal((await put({ schedule: s, destination })).status, 400, JSON.stringify(destination))
  }
  assert.equal((await put({ schedule: s, destination: s3 })).status, 200)
})

test('an operator can keep personal backups on the server only', async () => {
  const { h, token } = await account({ remoteBackups: false })
  const res = await h.request('PUT', '/api/backups/config', { token, body: { schedule: SERVER_DAILY.schedule, destination: { type: 'webdav', url: 'https://dav.example.com/', username: 'me', password: 'pw' } } })
  assert.equal(res.status, 400)
  assert.equal((await h.request('GET', '/api/backups', { token })).body['remoteAllowed'], false)
})

test('back up now is rate limited', async () => {
  const { h, token } = await account()
  const statuses = []
  for (let i = 0; i < 7; i++) statuses.push((await h.request('POST', '/api/backups/run', { token })).status)
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429])
})

// ── Real deliveries ───────────────────────────────────────────────────────

interface Seen { method: string; url: string; auth: string; body: string }
async function stand(handler: (req: IncomingMessage, body: string) => [number, string]): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const store = new Map<string, string>()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization ?? ''), body })
      const [status, out] = handler(req, body)
      if (status < 300 && req.method === 'PUT') store.set(req.url!, body)
      if (status < 300 && req.method === 'DELETE') store.delete(req.url!)
      res.writeHead(status)
      res.end(req.method === 'GET' && status < 300 ? (store.get(req.url!) ?? '') : out)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

test('WebDAV: uploads with the sealed password, prunes old copies, and fetches the newest back', async () => {
  const dav = await stand(() => [201, ''])
  try {
    const { h, token } = await account({ allowPrivate: true })
    const dest = { type: 'webdav', url: `${dav.url}/dav/backups/`, username: 'asha', password: 'dav-password' }
    assert.equal((await h.request('PUT', '/api/backups/config', { token, body: { schedule: { ...SERVER_DAILY.schedule, keep: 2 }, destination: dest } })).status, 200)
    const shown = (await h.request('GET', '/api/backups', { token })).body['destination'] as Record<string, unknown>
    assert.equal(shown['hasSecret'], true)
    assert.equal(shown['password'], undefined)
    assert.ok(!JSON.stringify(h.store.dump()).includes('dav-password'), 'the password is sealed at rest')

    for (let i = 0; i < 3; i++) {
      h.setNow(Date.UTC(2026, 8, 22, 12, i, 0))
      assert.equal((await h.request('POST', '/api/backups/run', { token })).status, 200)
    }
    const puts = dav.seen.filter((s) => s.method === 'PUT')
    assert.equal(puts.length, 3)
    assert.equal(puts[0]!.auth, `Basic ${Buffer.from('asha:dav-password').toString('base64')}`)
    assert.match(puts[0]!.url, /^\/dav\/backups\/vault-backup-.*\.json$/)
    assert.equal(JSON.parse(puts[0]!.body).format, 'vault-personal-backup')
    const deletes = dav.seen.filter((s) => s.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.equal(deletes[0]!.url, puts[0]!.url, 'the oldest copy is removed')

    const latest = await h.request('GET', '/api/backups/latest', { token })
    assert.equal(latest.status, 200)
    assert.equal(latest.body['body'], puts[2]!.body)

    // Saving again without the password keeps the stored one.
    await h.request('PUT', '/api/backups/config', { token, body: { schedule: SERVER_DAILY.schedule, destination: { ...dest, password: undefined } } })
    h.setNow(Date.UTC(2026, 8, 22, 13, 0, 0))
    await h.request('POST', '/api/backups/run', { token })
    assert.equal(dav.seen.at(-1)!.auth.length > 0 && dav.seen.filter((s) => s.method === 'PUT').at(-1)!.auth, puts[0]!.auth)
  } finally {
    dav.server.close()
  }
})

test('WebDAV refusing the password: the run fails, says why, and is recorded', async () => {
  const dav = await stand(() => [401, 'nope'])
  try {
    const { h, token } = await account({ allowPrivate: true })
    await h.request('PUT', '/api/backups/config', { token, body: { schedule: SERVER_DAILY.schedule, destination: { type: 'webdav', url: `${dav.url}/dav/`, username: 'u', password: 'p' } } })
    const res = await h.request('POST', '/api/backups/run', { token })
    assert.equal(res.status, 502)
    const run = res.body['run'] as Record<string, unknown>
    assert.equal(run['ok'], false)
    assert.match(String(run['error']), /refused the user name or password/)
    assert.equal(((await h.request('GET', '/api/backups', { token })).body['runs'] as unknown[]).length, 1)
  } finally {
    dav.server.close()
  }
})

test('without the operator allowing private addresses, a LAN destination is never contacted', async () => {
  const dav = await stand(() => [201, ''])
  try {
    const { h, token } = await account()
    const res = await h.request('PUT', '/api/backups/config', { token, body: { schedule: SERVER_DAILY.schedule, destination: { type: 'webdav', url: `${dav.url}/dav/`, username: 'u', password: 'p' } } })
    assert.equal(res.status, 400)
    assert.equal(dav.seen.length, 0)
  } finally {
    dav.server.close()
  }
})

test('S3: a signed PUT to bucket/prefix/name, with the secret key sealed at rest', async () => {
  const s3 = await stand(() => [200, ''])
  try {
    const { h, token } = await account({ allowPrivate: true })
    const dest = { type: 's3', endpoint: s3.url, region: 'eu-central-1', bucket: 'my-bucket', prefix: 'people/asha', accessKey: 'AKIDEXAMPLE', secretKey: 's3-secret-key' }
    assert.equal((await h.request('PUT', '/api/backups/config', { token, body: { schedule: SERVER_DAILY.schedule, destination: dest } })).status, 200)
    assert.ok(!JSON.stringify(h.store.dump()).includes('s3-secret-key'))
    assert.equal((await h.request('POST', '/api/backups/run', { token })).status, 200)
    const put = s3.seen.find((s) => s.method === 'PUT')!
    assert.match(put.url, /^\/my-bucket\/people\/asha\/vault-backup-.*\.json$/)
    assert.match(put.auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request/)
    const latest = await h.request('GET', '/api/backups/latest', { token })
    assert.equal(JSON.parse(String(latest.body['body'])).format, 'vault-personal-backup')
  } finally {
    s3.server.close()
  }
})

test('copies on the server are capped at ten, whatever is asked', async () => {
  const { h, token, userId } = await account()
  await h.request('PUT', '/api/backups/config', { token, body: { ...SERVER_DAILY, schedule: { ...SERVER_DAILY.schedule, keep: 30 } } })
  for (let i = 0; i < 12; i++) {
    h.setNow(Date.UTC(2026, 8, 22, 12, 0, i))
    await runBackup(h.app, userId, 'manual')
  }
  assert.equal(((await h.request('GET', '/api/backups', { token })).body['copies'] as unknown[]).length, 10)
})

test('test restore is rate limited too', async () => {
  const { h, token } = await account()
  await h.request('POST', '/api/backups/run', { token })
  const statuses = []
  for (let i = 0; i < 7; i++) statuses.push((await h.request('GET', '/api/backups/latest', { token })).status)
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429])
})
