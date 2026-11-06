// Reading other managers' exports, and writing our CSV. Fixtures follow each
// manager's published export layout; values are made up.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ImportError, duplicateKey, parseCsv, readImport, toCsv, totpKey } from '../src/index.js'

test('CSV parser handles quotes, doubled quotes, newlines in fields, CRLF and a BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,,3')
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2'], ['1', '', '3']])
})

test('TOTP keys come out of otpauth URIs and bare keys; junk is dropped', () => {
  assert.equal(totpKey('otpauth://totp/GitHub:me?secret=JBSW%20Y3DP&issuer=GitHub'), 'JBSWY3DP')
  assert.equal(totpKey('jbsw y3dp ehpk 3pxp'), 'JBSWY3DPEHPK3PXP')
  assert.equal(totpKey('not a key!'), undefined)
  assert.equal(totpKey(''), undefined)
})

test('Chrome / Edge CSV', () => {
  const r = readImport('name,url,username,password,note\nGitHub,https://github.com/login,me@example.com,hunter2,work\n,https://www.example.org/,a,b,\n')
  assert.equal(r.format, 'Chrome, Edge or Brave')
  assert.equal(r.items.length, 2)
  assert.deepEqual(r.items[0], { name: 'GitHub', type: 'login', url: 'https://github.com/login', username: 'me@example.com', password: 'hunter2', notes: 'work', customFields: [], tags: [], favorite: false, folder: '' })
  assert.equal(r.items[1]!.name, 'example.org', 'a nameless row is named after its site')
})

test('Firefox CSV names entries after the site', () => {
  const r = readImport('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://accounts.example.com","me","pw","","https://accounts.example.com","{abc}","1","1","1"\n')
  assert.equal(r.format, 'Firefox')
  assert.equal(r.items[0]!.name, 'accounts.example.com')
  assert.equal(r.items[0]!.password, 'pw')
})

test('Bitwarden JSON: types, folders, fields, favorites, extra URIs', () => {
  const json = JSON.stringify({
    encrypted: false,
    folders: [{ id: 'f1', name: 'Work/Servers' }],
    items: [
      { type: 1, name: 'Gitea', folderId: 'f1', favorite: true, notes: 'n',
        login: { username: 'u', password: 'p', totp: 'otpauth://totp/x?secret=ABCDEFGH', uris: [{ uri: 'https://git.example.com' }, { uri: 'https://alt.example.com' }] },
        fields: [{ name: 'PIN', value: '1234', type: 1 }, { name: 'Region', value: 'eu', type: 0 }] },
      { type: 2, name: 'Recovery codes', notes: 'a b c', folderId: null },
      { type: 3, name: 'Visa', card: { cardholderName: 'A B', number: '4111111111111111', expMonth: '3', expYear: '2029', code: '123' } },
      { type: 4, name: 'Me', identity: { firstName: 'Asha', lastName: 'Rao', email: 'a@example.com', city: 'Pune', country: 'IN' } },
      { type: 9, name: 'Strange' },
    ],
  })
  const r = readImport(json)
  assert.equal(r.format, 'Bitwarden (JSON)')
  assert.deepEqual(r.folders, ['Work', 'Work / Servers'])
  const [login, note, card, id, odd] = r.items
  assert.equal(login!.folder, 'Work / Servers')
  assert.equal(login!.favorite, true)
  assert.equal(login!.totpSecret, 'ABCDEFGH')
  assert.deepEqual(login!.customFields, [
    { label: 'PIN', value: '1234', hidden: true },
    { label: 'Region', value: 'eu', hidden: false },
    { label: 'Website', value: 'https://alt.example.com', hidden: false },
  ])
  assert.equal(note!.type, 'note')
  assert.equal(note!.folder, '')
  assert.deepEqual(card!.fields, { cardholder: 'A B', number: '4111111111111111', expiry: '03/29', cvv: '123' })
  assert.equal(id!.type, 'identity')
  assert.equal(id!.fields!['fullName'], 'Asha Rao')
  assert.equal(id!.fields!['address'], 'Pune\nIN')
  assert.equal(odd!.type, 'note')
  assert.equal(r.warnings.length, 1)
})

test('an encrypted Bitwarden export is refused with a way out', () => {
  assert.throws(() => readImport('{"encrypted":true,"items":[]}'), (e: unknown) => e instanceof ImportError && /JSON \(Encrypted\)/.test(e.message))
})

test('Bitwarden CSV', () => {
  const r = readImport('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\nSocial,1,login,Mastodon,,"Recovery: abc\nBackup: def",0,https://m.example,me,pw,JBSWY3DP\n,,note,Wifi notes,secret stuff,,0,,,,\n')
  assert.equal(r.format, 'Bitwarden (CSV)')
  assert.equal(r.items[0]!.folder, 'Social')
  assert.equal(r.items[0]!.favorite, true)
  assert.deepEqual(r.items[0]!.customFields, [{ label: 'Recovery', value: 'abc', hidden: false }, { label: 'Backup', value: 'def', hidden: false }])
  assert.equal(r.items[1]!.type, 'note')
  assert.equal(r.items[1]!.notes, 'secret stuff')
})

test('LastPass CSV: secure notes and nested groups', () => {
  const r = readImport('url,username,password,totp,extra,name,grouping,fav\nhttps://bank.example,cust1,pw,,,Bank,Finance\\India,1\nhttp://sn,,,,the note,Passport,Docs,0\n')
  assert.equal(r.format, 'LastPass')
  assert.equal(r.items[0]!.folder, 'Finance / India')
  assert.equal(r.items[0]!.favorite, true)
  assert.equal(r.items[1]!.type, 'note')
  assert.equal(r.items[1]!.url, undefined)
  assert.equal(r.items[1]!.notes, 'the note')
})

test('1Password CSV: tags and archived', () => {
  const r = readImport('Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nAWS,https://aws.example,root,pw,otpauth://totp/a?secret=MZXW6YQ,true,true,"cloud;work",hi\n')
  assert.equal(r.format, '1Password')
  assert.deepEqual(r.items[0]!.tags, ['cloud', 'work', 'archived'])
  assert.equal(r.items[0]!.totpSecret, 'MZXW6YQ')
})

test('KeePass CSV drops the Root group', () => {
  const r = readImport('"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"\n"Root/Internet","Forum","me","pw","https://f.example","","","0","",""\n')
  assert.equal(r.format, 'KeePass / KeePassXC')
  assert.equal(r.items[0]!.folder, 'Internet')
})

test('Zoho Vault CSV reads SecretData lines', () => {
  const r = readImport('Password Name,Description,Password URL,SecretData,Notes,Tags,Favorite,TOTP,ChamberName\nJira,,https://jira.example,"User Name:dev\nPassword:pw\nAPI token:xyz",,ops,1,,Client A\n')
  assert.equal(r.format, 'Zoho Vault')
  const it = r.items[0]!
  assert.equal(it.username, 'dev')
  assert.equal(it.password, 'pw')
  assert.deepEqual(it.customFields, [{ label: 'API token', value: 'xyz', hidden: true }])
  assert.equal(it.folder, 'Client A')
  assert.deepEqual(it.tags, ['ops'])
})

test('unknown CSV with recognisable columns is guessed, with a warning', () => {
  const r = readImport('Account,Website,Login,Pass word,Comment\nShop,shop.example,me,pw,x\n')
  assert.match(r.format, /guessed/)
  assert.equal(r.items[0]!.password, 'pw')
  assert.equal(r.items[0]!.username, 'me')
  assert.equal(r.warnings.length, 1)
})

test('files that cannot be read say why', () => {
  assert.throws(() => readImport('  '), ImportError)
  assert.throws(() => readImport('a,b\n1,2\n'), ImportError)
  assert.throws(() => readImport('{"format":"vault-export"}'), /export password/)
  assert.throws(() => readImport('{nope'), ImportError)
})

test('duplicate key ignores case, www and path', () => {
  assert.equal(duplicateKey({ name: 'GitHub', username: 'Me', url: 'https://www.github.com/login' }), duplicateKey({ name: 'github ', username: 'me', url: 'github.com' }))
  assert.notEqual(duplicateKey({ name: 'GitHub', username: 'a' }), duplicateKey({ name: 'GitHub', username: 'b' }))
})

test('CSV export round-trips through our own Bitwarden CSV import', () => {
  const csv = toCsv([
    { name: 'Git, "the" host', type: 'login', username: 'u', password: 'p,w', url: 'https://g.example', totpSecret: 'JBSWY3DP', notes: 'a\nb', favorite: true, folder: 'Work / Dev', customFields: [{ label: 'Port', value: '22', hidden: false }] },
    { name: 'Visa', type: 'card', fields: { cardholder: 'A', number: '4111' } },
    { name: 'Home', type: 'wifi', username: 'ssid', password: 'pw', fields: { security: 'wpa3' } },
  ])
  const r = readImport(csv)
  assert.equal(r.format, 'Bitwarden (CSV)')
  const [login, card, wifi] = r.items
  assert.equal(login!.name, 'Git, "the" host')
  assert.equal(login!.password, 'p,w')
  assert.equal(login!.notes, 'a\nb')
  assert.equal(login!.folder, 'Work / Dev')
  assert.equal(login!.favorite, true)
  assert.equal(login!.totpSecret, 'JBSWY3DP')
  assert.deepEqual(login!.customFields, [{ label: 'Port', value: '22', hidden: false }])
  assert.equal(card!.type, 'note')
  assert.deepEqual(card!.customFields.map((c) => c.label), ['Name on card', 'Card number'])
  assert.equal(wifi!.username, 'ssid')
  assert.deepEqual(wifi!.customFields, [{ label: 'Security', value: 'wpa3', hidden: false }])
})
