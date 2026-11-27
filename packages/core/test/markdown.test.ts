// Markdown in notes: a tree, never HTML; unknown things stay text.

import test from 'node:test'
import assert from 'node:assert/strict'

import { looksLikeMarkdown, parseInline, parseMarkdown } from '../src/index.js'

test('headings, paragraphs, lists, checklists, quotes, code and rules', () => {
  const blocks = parseMarkdown([
    '# Wi-Fi at home', '', 'Router in the hall.', 'Second line.', '',
    '- one', '- two', '', '1. first', '2) second', '',
    '- [x] paid', '- [ ] renew', '', '> keep safe', '', '```', 'ssh admin@10.0.0.1', '**not bold**', '```', '', '---',
  ].join('\n'))
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'paragraph', 'list', 'list', 'list', 'quote', 'code', 'rule'])
  assert.deepEqual(blocks[0], { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'Wi-Fi at home' }] })
  assert.deepEqual(blocks[1], { kind: 'paragraph', children: [{ kind: 'text', text: 'Router in the hall.\nSecond line.' }] })
  const ordered = blocks[3] as { ordered: boolean; items: unknown[] }
  assert.equal(ordered.ordered, true)
  assert.equal(ordered.items.length, 2)
  const tasks = blocks[4] as { items: { checked: boolean | null }[] }
  assert.deepEqual(tasks.items.map((i) => i.checked), [true, false])
  assert.deepEqual(blocks[6], { kind: 'code', text: 'ssh admin@10.0.0.1\n**not bold**' }, 'code is kept verbatim')
})

test('inline marks, links and bare addresses', () => {
  assert.deepEqual(parseInline('a **b** _c_ ~~d~~ `e`'), [
    { kind: 'text', text: 'a ' }, { kind: 'strong', children: [{ kind: 'text', text: 'b' }] }, { kind: 'text', text: ' ' },
    { kind: 'em', children: [{ kind: 'text', text: 'c' }] }, { kind: 'text', text: ' ' },
    { kind: 'del', children: [{ kind: 'text', text: 'd' }] }, { kind: 'text', text: ' ' }, { kind: 'code', text: 'e' },
  ])
  assert.deepEqual(parseInline('[portal](https://example.com/x)'), [{ kind: 'link', href: 'https://example.com/x', children: [{ kind: 'text', text: 'portal' }] }])
  assert.deepEqual(parseInline('see https://example.com/a.'), [
    { kind: 'text', text: 'see ' }, { kind: 'link', href: 'https://example.com/a', children: [{ kind: 'text', text: 'https://example.com/a' }] }, { kind: 'text', text: '.' },
  ])
})

test('things that are not Markdown stay text', () => {
  assert.deepEqual(parseInline('my_db_name and 2 * 3 * 4'), [{ kind: 'text', text: 'my_db_name and 2 * 3 * 4' }])
  assert.deepEqual(parseInline('**open only'), [{ kind: 'text', text: '**open only' }])
  assert.deepEqual(parseInline('\\*literal\\*'), [{ kind: 'text', text: '*literal*' }])
  assert.deepEqual(parseInline('<script>alert(1)</script>'), [{ kind: 'text', text: '<script>alert(1)</script>' }], 'markup is just text')
  const [link] = parseInline('[x](javascript:alert(1))')
  assert.equal(link!.kind, 'link', 'the reader keeps the address; the app refuses to open it')
})

test('looksLikeMarkdown tells formatted notes from plain ones', () => {
  assert.equal(looksLikeMarkdown('PIN 4821, ask for Ravi'), false)
  assert.equal(looksLikeMarkdown('price is 2*3'), false)
  assert.equal(looksLikeMarkdown('# Title'), true)
  assert.equal(looksLikeMarkdown('- [ ] one'), true)
  assert.equal(looksLikeMarkdown('use **this** one'), true)
})
