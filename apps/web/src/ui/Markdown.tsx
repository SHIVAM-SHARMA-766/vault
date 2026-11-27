// Draws a note's Markdown (packages/core/src/markdown.ts) with ordinary
// elements: no HTML string is ever built or injected. Links open only for
// http and https, in a new tab without a referrer; anything else shows as text.

import { type ReactNode } from 'react'

import { type Block, type Inline, parseMarkdown } from '@vault/core'

function safeHref(href: string): string | null {
  try {
    const u = new URL(href)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch { return null }
}

function inline(nodes: Inline[], key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`
    switch (n.kind) {
      case 'text': return n.text
      case 'strong': return <strong key={k}>{inline(n.children, k)}</strong>
      case 'em': return <em key={k}>{inline(n.children, k)}</em>
      case 'del': return <del key={k}>{inline(n.children, k)}</del>
      case 'code': return <code key={k}>{n.text}</code>
      case 'link': {
        const href = safeHref(n.href)
        return href ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{inline(n.children, k)}</a> : <span key={k}>{inline(n.children, k)}</span>
      }
    }
  })
}

function block(b: Block, i: number): ReactNode {
  switch (b.kind) {
    case 'heading': {
      const H = (['h3', 'h4', 'h5'] as const)[b.level - 1]!
      return <H key={i}>{inline(b.children)}</H>
    }
    case 'paragraph': return <p key={i}>{inline(b.children)}</p>
    case 'quote': return <blockquote key={i}>{inline(b.children)}</blockquote>
    case 'code': return <pre key={i}><code>{b.text}</code></pre>
    case 'rule': return <hr key={i} />
    case 'list': {
      const L = b.ordered ? 'ol' : 'ul'
      const tasks = b.items.some((x) => x.checked !== null)
      return (
        <L key={i} className={tasks ? 'md-tasks' : undefined}>
          {b.items.map((item, j) => (
            <li key={j} className={item.checked ? 'md-done' : undefined}>
              {item.checked !== null ? <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Done' : 'Not done'} /> : null}
              <span>{inline(item.children)}</span>
            </li>
          ))}
        </L>
      )
    }
  }
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  return <div className={`markdown ${className ?? ''}`}>{parseMarkdown(source).map(block)}</div>
}
