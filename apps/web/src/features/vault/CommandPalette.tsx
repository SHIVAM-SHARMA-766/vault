// The command palette (E4): Ctrl/⌘+K, type, Enter. Finds items by the same
// search as the list, and runs actions — new item, go to a screen, lock —
// without the mouse. Shift+Enter on an item copies its password.

import { useEffect, useMemo, useRef, useState } from 'react'

import { matches, subtitle } from '@vault/core'

import { IconSearch } from '../../ui/icons.js'
import { Monogram } from '../../ui/kit.js'
import type { Decrypted } from './model.js'

export interface PaletteAction { id: string; label: string; hint?: string; keys?: string; run: () => void }

type Row = { kind: 'action'; action: PaletteAction } | { kind: 'item'; item: Decrypted }

export function CommandPalette({ items, actions, onOpenItem, onCopyPassword, onClose }: {
  items: Decrypted[]
  actions: PaletteAction[]
  onOpenItem: (id: string) => void
  onCopyPassword: (item: Decrypted) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    const acts = actions.filter((a) => !q || a.label.toLowerCase().includes(q) || a.hint?.toLowerCase().includes(q))
    const found = q ? items.filter((e) => !e.unreadable && matches(e, q, '')).slice(0, 8) : items.slice(0, 5)
    // Typing a name usually means an item: items first once there is a query.
    const itemRows: Row[] = found.map((item) => ({ kind: 'item', item }))
    const actionRows: Row[] = acts.slice(0, q ? 5 : 12).map((action) => ({ kind: 'action', action }))
    return q ? [...itemRows, ...actionRows] : [...actionRows, ...itemRows]
  }, [query, items, actions])

  useEffect(() => { setIndex(0) }, [query])
  useEffect(() => { listRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }) }, [index])

  function choose(row: Row | undefined, copy = false) {
    if (!row) return
    onClose()
    if (row.kind === 'action') row.action.run()
    else if (copy) onCopyPassword(row.item)
    else onOpenItem(row.item.id)
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(rows.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(rows[index], e.shiftKey) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  const active = rows[index]
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <IconSearch size={16} />
          <input autoFocus role="combobox" aria-expanded="true" aria-controls="palette-list" aria-label="Search items and actions"
                 aria-activedescendant={active ? `pal-${index}` : undefined} placeholder="Search items, or type a command…"
                 value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
          <kbd>Esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" ref={listRef} className="palette-list">
          {rows.length === 0 ? <li className="palette-empty muted small">Nothing matches.</li> : rows.map((row, i) => (
            <li key={row.kind === 'item' ? `i${row.item.id}` : `a${row.action.id}`} id={`pal-${i}`} role="option" aria-selected={i === index}
                className={`palette-row ${i === index ? 'is-active' : ''}`} onMouseEnter={() => setIndex(i)} onMouseDown={(e) => { e.preventDefault(); choose(row) }}>
              {row.kind === 'item' ? (
                <>
                  <Monogram name={row.item.name} />
                  <span className="palette-text"><span className="truncate">{row.item.name || 'Untitled'}</span><span className="muted small truncate">{subtitle(row.item)}</span></span>
                  {row.item.password && i === index ? <span className="palette-keys muted small"><kbd>⇧</kbd><kbd>Enter</kbd> copy password</span> : null}
                </>
              ) : (
                <>
                  <span className="palette-text"><span>{row.action.label}</span>{row.action.hint ? <span className="muted small">{row.action.hint}</span> : null}</span>
                  {row.action.keys ? <span className="palette-keys">{row.action.keys.split(' ').map((k) => <kbd key={k}>{k}</kbd>)}</span> : null}
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="palette-foot muted small"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>?</kbd> all shortcuts</div>
      </div>
    </div>
  )
}

export const SHORTCUTS: readonly [string, string][] = [
  ['Ctrl K / ⌘ K', 'Command palette: find an item or run an action'],
  ['/', 'Search the list'],
  ['N', 'New item'],
  ['J / K', 'Next / previous item in the list'],
  ['E', 'Edit the open item'],
  ['S', 'Select several items'],
  ['L', 'Lock the vault'],
  ['?', 'This list'],
  ['Esc', 'Close the editor, then the open item'],
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="ks-title" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <h2 id="ks-title">Keyboard shortcuts</h2>
        <table className="shortcuts">
          <tbody>{SHORTCUTS.map(([k, d]) => <tr key={k}><td>{k.split(' / ').map((x, i) => <span key={x}>{i ? ' / ' : ''}{x.split(' ').map((y) => <kbd key={y}>{y}</kbd>)}</span>)}</td><td>{d}</td></tr>)}</tbody>
        </table>
        <div className="modal-actions"><button className="btn btn-primary" autoFocus onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}
