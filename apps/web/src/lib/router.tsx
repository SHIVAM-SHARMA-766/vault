// A router small enough to read, for a client with a handful of screens.
//
// It exists for one reason a library would not know about: navigating must
// never reload the page. Keys live only in memory, and a reload locks the
// vault. So every in-app link changes the address with the History API and
// lets the app re-render; nothing here ever assigns location.href.
//
// Addresses are real (/app/settings, /app/admin/users), so reload, back and
// bookmarks behave; Caddy serves the shell for any /app/* path.

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'

export type Route =
  | { name: 'vault' }
  | { name: 'settings'; tab?: string | null }
  | { name: 'transfer' }
  | { name: 'support' }
  | { name: 'orgs' }
  | { name: 'admin'; tab: string | null }

export function parse(pathname: string): Route {
  const parts = pathname.replace(/^\/app\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'settings') return { name: 'settings', tab: parts[1] ?? null }
  if (parts[0] === 'import-export') return { name: 'transfer' }
  if (parts[0] === 'support') return { name: 'support' }
  if (parts[0] === 'orgs') return { name: 'orgs' }
  if (parts[0] === 'admin') return { name: 'admin', tab: parts[1] ?? null }
  return { name: 'vault' }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'vault': return '/app/'
    case 'settings': return route.tab ? `/app/settings/${route.tab}` : '/app/settings'
    case 'transfer': return '/app/import-export'
    case 'support': return '/app/support'
    case 'orgs': return '/app/orgs'
    case 'admin': return route.tab ? `/app/admin/${route.tab}` : '/app/admin'
  }
}

const EVENT = 'vault:navigate'

export function navigate(to: string, { replace = false } = {}): void {
  if (to === location.pathname) return
  if (replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  window.dispatchEvent(new Event(EVENT))
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname))
  useEffect(() => {
    const update = () => setRoute(parse(location.pathname))
    window.addEventListener('popstate', update)
    window.addEventListener(EVENT, update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener(EVENT, update)
    }
  }, [])
  return route
}

/** An in-app link. Ordinary clicks navigate in place; modified clicks (new
 *  tab, new window) fall through to the browser, which opens a fresh, locked
 *  copy — the correct outcome for a separate tab. */
export function Link({ to, children, className, ...rest }: {
  to: string
  children: ReactNode
  className?: string
  title?: string
  'aria-current'?: 'page' | undefined
  role?: string
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return <a href={to} className={className} onClick={onClick} {...rest}>{children}</a>
}
