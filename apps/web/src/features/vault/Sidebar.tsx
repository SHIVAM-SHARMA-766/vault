// The vault's left column: everything, favourites, each type, and the folder
// tree with its own actions.

import { useState } from 'react'

import { MAX_FOLDER_DEPTH, type FolderNode, type Issue, describeMinutes, folderTree } from '@vault/core'
import { usePrefs } from '../../lib/prefs.js'
import { idleMinutes } from '../../lib/session.js'

import { IconEdit, IconFolder, IconGrid, IconInbox, IconLock, IconNote, IconPlus, IconPulse, IconStar, IconTrash, IconUsers } from '../../ui/icons.js'
import { TYPES } from '../../ui/kit.js'
import type { Folder } from './model.js'
import { t } from '../../lib/i18n.js'

export type Filter = { kind: 'health'; issue?: Issue } | { kind: 'collection'; id: string } | { kind: 'all' } | { kind: 'favorites' } | { kind: 'type'; type: string } | { kind: 'folder'; id: string } | { kind: 'unfiled' } | { kind: 'archive' } | { kind: 'template'; id: string }

export const sameFilter = (a: Filter, b: Filter) => JSON.stringify(a) === JSON.stringify(b)

export function Sidebar({ filter, setFilter, counts, folders, folderCounts, collections, onNewFolder, onRenameFolder, onDeleteFolder }: {
  collections: { id: string; label: string; group: string }[]
  filter: Filter
  setFilter: (f: Filter) => void
  counts: Record<string, number>
  folders: Folder[]
  folderCounts: Map<string, number>
  onNewFolder: (parentId?: string) => void
  onRenameFolder: (folder: Folder) => void
  onDeleteFolder: (folder: Folder) => void
}) {
  const { templates } = usePrefs() // also redraws when the idle lock changes
  const tree = folderTree(folders)
  return (
    <nav className="sidebar" aria-label="Filter">
      <SideItem active={filter.kind === 'all'} onClick={() => setFilter({ kind: 'all' })} icon={<IconGrid size={16} />} label={t('All items')} count={counts['all']} />
      <SideItem active={filter.kind === 'favorites'} onClick={() => setFilter({ kind: 'favorites' })} icon={<IconStar size={16} />} label={t('Favorites')} count={counts['favorites']} />
      <SideItem active={filter.kind === 'health'} onClick={() => setFilter({ kind: 'health' })} icon={<IconPulse size={16} />} label={t('Password health')} count={counts['health']} warn />
      <SideItem active={filter.kind === 'archive'} onClick={() => setFilter({ kind: 'archive' })} icon={<IconInbox size={16} />} label={t('Archive')} count={counts['archive']} />

      <div className="sidebar-heading sidebar-heading-row">
        <span>{t('Folders')}</span>
        <button className="icon-btn icon-sm" title={t('New folder')} aria-label={t('New folder')} onClick={() => onNewFolder()}><IconPlus size={14} /></button>
      </div>
      {tree.length === 0 ? <p className="sidebar-empty">{t('No folders yet.')}</p> : null}
      {tree.map((node) => (
        <FolderItem key={node.folder.id} node={node} filter={filter} setFilter={setFilter} counts={folderCounts}
                    onNew={onNewFolder} onRename={onRenameFolder} onDelete={onDeleteFolder} />
      ))}
      {folders.length ? (
        <SideItem active={filter.kind === 'unfiled'} onClick={() => setFilter({ kind: 'unfiled' })} icon={<IconFolder size={16} />} label={t('No folder')} count={counts['unfiled']} muted />
      ) : null}

      {collections.length ? <>
        <div className="sidebar-heading">{t('Shared')}</div>
        {collections.map((c) => (
          <SideItem key={c.id} active={filter.kind === 'collection' && filter.id === c.id} onClick={() => setFilter({ kind: 'collection', id: c.id })}
                    icon={<IconUsers size={16} />} label={c.label} title={`${c.group} / ${c.label}`} count={counts[`coll:${c.id}`]} />
        ))}
      </> : null}

      <div className="sidebar-heading">{t('Types')}</div>
      {/* Only the types this vault holds (and the one being viewed), so
          fifteen types do not push folders off the screen. */}
      {templates.filter((tp) => counts[`tpl:${tp.id}`] || (filter.kind === 'template' && filter.id === tp.id)).map((tp) => (
        <SideItem key={tp.id} active={filter.kind === 'template' && filter.id === tp.id} onClick={() => setFilter({ kind: 'template', id: tp.id })}
                  icon={<IconNote size={16} />} label={tp.name} count={counts[`tpl:${tp.id}`]} />
      ))}
      {TYPES.filter(({ type }) => counts[type] || (filter.kind === 'type' && filter.type === type)).map(({ type, plural, Icon }) => (
        <SideItem key={type} active={filter.kind === 'type' && filter.type === type} onClick={() => setFilter({ kind: 'type', type })}
                  icon={<Icon size={16} />} label={t(plural)} count={counts[type]} />
      ))}
      <div className="sidebar-foot">
        <IconLock size={14} /> End-to-end encrypted. Locks after {describeMinutes(idleMinutes())} idle.
      </div>
    </nav>
  )
}

function FolderItem({ node, filter, setFilter, counts, onNew, onRename, onDelete }: {
  node: FolderNode<Folder>
  filter: Filter
  setFilter: (f: Filter) => void
  counts: Map<string, number>
  onNew: (parentId?: string) => void
  onRename: (f: Folder) => void
  onDelete: (f: Folder) => void
}) {
  const [hover, setHover] = useState(false)
  const active = filter.kind === 'folder' && filter.id === node.folder.id
  return (
    <>
      <div className={`folder-item ${active ? 'side-active' : ''}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <button className={`side-item folder-depth-${Math.min(node.depth, 3)}`} onClick={() => setFilter({ kind: 'folder', id: node.folder.id })} aria-current={active}>
          <IconFolder size={16} /><span>{node.folder.name}</span>
          {!hover && counts.get(node.folder.id) ? <span className="side-count">{counts.get(node.folder.id)}</span> : null}
        </button>
        <span className={`folder-actions ${hover || active ? 'folder-actions-on' : ''}`}>
          {node.depth + 1 < MAX_FOLDER_DEPTH ? (
            <button className="icon-btn icon-sm" title="New folder inside" aria-label={`New folder inside ${node.folder.name}`} onClick={() => onNew(node.folder.id)}><IconPlus size={13} /></button>
          ) : null}
          <button className="icon-btn icon-sm" title="Rename" aria-label={`Rename ${node.folder.name}`} onClick={() => onRename(node.folder)}><IconEdit size={13} /></button>
          <button className="icon-btn icon-sm icon-danger" title="Delete folder" aria-label={`Delete ${node.folder.name}`} onClick={() => onDelete(node.folder)}><IconTrash size={13} /></button>
        </span>
      </div>
      {node.children.map((child) => (
        <FolderItem key={child.folder.id} node={child} filter={filter} setFilter={setFilter} counts={counts}
                    onNew={onNew} onRename={onRename} onDelete={onDelete} />
      ))}
    </>
  )
}

function SideItem({ active, onClick, icon, label, count, muted, warn, title }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number | undefined; muted?: boolean; warn?: boolean; title?: string
}) {
  return (
    <button className={`side-item ${active ? 'side-active' : ''} ${muted ? 'side-muted' : ''}`} onClick={onClick} aria-current={active} title={title}>
      {icon}<span>{label}</span>{count ? <span className={`side-count ${warn ? 'side-count-warn' : ''}`}>{count}</span> : null}
    </button>
  )
}
