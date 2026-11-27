// A small Markdown reader for notes: headings, paragraphs, lists, checklists,
// quotes, code, rules, and inline bold, italic, strike, code and links.
//
// It returns a tree, never HTML, so the app draws it with ordinary elements
// and nothing in a note can become markup or script. Links keep their text and
// address; whoever draws them decides which addresses may open (http and https
// only, in the app). Anything it does not understand stays as plain text.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }

export type ListItem = { checked: boolean | null; children: Inline[] }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: ListItem[] }
  | { kind: 'quote'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }

const LIST = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/
const TASK = /^\[([ xX])\]\s+(.*)$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s{0,3}(```|~~~)/

/** The blocks of a note, in order. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'paragraph', children: parseInline(para.join('\n')) })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) body.push(lines[i]!)
      out.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      out.push({ kind: 'heading', level: Math.min(heading[1]!.length, 3) as 1 | 2 | 3, children: parseInline(heading[2]!) })
      continue
    }
    if (RULE.test(line) && !para.length) { out.push({ kind: 'rule' }); continue }
    if (/^\s{0,3}>/.test(line)) {
      flush()
      const body: string[] = []
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''))
      i--
      out.push({ kind: 'quote', children: parseInline(body.join('\n')) })
      continue
    }
    const item = LIST.exec(line)
    if (item) {
      flush()
      const ordered = /\d/.test(item[1]!)
      const items: ListItem[] = []
      for (; i < lines.length; i++) {
        const m = LIST.exec(lines[i]!)
        if (!m || /\d/.test(m[1]!) !== ordered) break
        const task = TASK.exec(m[2]!)
        items.push(task ? { checked: task[1] !== ' ', children: parseInline(task[2]!) } : { checked: null, children: parseInline(m[2]!) })
      }
      i--
      out.push({ kind: 'list', ordered, items })
      continue
    }
    para.push(line)
  }
  flush()
  return out
}

const SIMPLE: { open: string; kind: 'strong' | 'em' | 'del' }[] = [
  { open: '**', kind: 'strong' }, { open: '__', kind: 'strong' }, { open: '~~', kind: 'del' }, { open: '*', kind: 'em' }, { open: '_', kind: 'em' },
]

/** Inline marks in a run of text. Unmatched marks stay as they are. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let plain = ''
  const push = (node: Inline) => { if (plain) out.push({ kind: 'text', text: plain }); plain = ''; out.push(node) }

  for (let i = 0; i < text.length;) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length && /[\\`*_~[\]()#>-]/.test(text[i + 1]!)) { plain += text[i + 1]; i += 2; continue }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) { push({ kind: 'code', text: text.slice(i + 1, end) }); i = end + 1; continue }
    }
    if (ch === '[') {
      const close = text.indexOf('](', i + 1)
      const end = close > i ? text.indexOf(')', close + 2) : -1
      if (close > i + 1 && end > close + 2 && !text.slice(i + 1, close).includes('\n')) {
        push({ kind: 'link', href: text.slice(close + 2, end).trim(), children: parseInline(text.slice(i + 1, close)) })
        i = end + 1
        continue
      }
    }
    // A bare web address becomes a link to itself.
    if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(text.slice(i, i + 8)) && (i === 0 || /[\s(]/.test(text[i - 1]!))) {
      const m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/i.exec(text.slice(i))
      if (m) { push({ kind: 'link', href: m[0], children: [{ kind: 'text', text: m[0] }] }); i += m[0].length; continue }
    }
    const mark = SIMPLE.find((s) => text.startsWith(s.open, i))
    if (mark) {
      const start = i + mark.open.length
      const end = text.indexOf(mark.open, start)
      // Words with underscores (snake_case) are not emphasis, and a mark must hug its text.
      const wordish = mark.open[0] === '_' && i > 0 && /\w/.test(text[i - 1]!)
      if (end > start && !wordish && !/\s/.test(text[start]!) && !/\s/.test(text[end - 1]!)) {
        push({ kind: mark.kind, children: parseInline(text.slice(start, end)) })
        i = end + mark.open.length
        continue
      }
      plain += mark.open
      i = start
      continue
    }
    plain += ch
    i++
  }
  if (plain) out.push({ kind: 'text', text: plain })
  return out
}

/** Whether a note uses any Markdown worth drawing; plain text stays plain. */
export function looksLikeMarkdown(source: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>|```|~~~)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/.test(source)
}
