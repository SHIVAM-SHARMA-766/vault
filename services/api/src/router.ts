// A router small enough to read. Paths are matched exactly or with a single
// parameter segment, in any position; there is no pattern language to get wrong.

import { type LambdaEvent, type LambdaResponse, notFound } from './http.js'

export interface RouteContext {
  event: LambdaEvent
  /** The value captured by a `:param` segment, when the route has one. */
  param: string
}

export type Handler = (ctx: RouteContext) => Promise<LambdaResponse>

/** How a route is authenticated, as recorded by the wrappers in app.ts. */
export interface AuthTag { auth?: 'access'; permission?: string }

export interface RouteInfo {
  method: string
  path: string
  summary: string
  auth: 'none' | 'access'
  permission?: string
}

interface Route {
  method: string
  path: string
  segments: string[]
  handler: Handler
  summary: string
}

export class Router {
  private readonly routes: Route[] = []

  add(method: string, path: string, handler: Handler, summary = ''): this {
    this.routes.push({
      method,
      path,
      segments: path.split('/').filter(Boolean),
      handler,
      summary,
    })
    return this
  }

  get = (path: string, handler: Handler, summary?: string) => this.add('GET', path, handler, summary)
  post = (path: string, handler: Handler, summary?: string) => this.add('POST', path, handler, summary)
  put = (path: string, handler: Handler, summary?: string) => this.add('PUT', path, handler, summary)
  delete = (path: string, handler: Handler, summary?: string) => this.add('DELETE', path, handler, summary)

  /** Every route, for the OpenAPI document. */
  list(): RouteInfo[] {
    return this.routes.map((r) => {
      const tag = r.handler as Handler & AuthTag
      return {
        method: r.method, path: r.path, summary: r.summary,
        auth: tag.auth ?? 'none',
        ...(tag.permission ? { permission: tag.permission } : {}),
      }
    })
  }

  async handle(event: LambdaEvent): Promise<LambdaResponse> {
    const method = event.requestContext.http.method.toUpperCase()
    const segments = event.rawPath.split('/').filter(Boolean)

    for (const route of this.routes) {
      if (route.method !== method) continue
      if (route.segments.length !== segments.length) continue

      let param = ''
      let matched = true
      for (let i = 0; i < route.segments.length; i++) {
        const expected = route.segments[i]!
        const actual = segments[i]!
        if (expected.startsWith(':')) {
          param = decodeURIComponent(actual)
          continue
        }
        if (expected !== actual) {
          matched = false
          break
        }
      }
      if (matched) return route.handler({ event, param })
    }

    throw notFound()
  }
}
