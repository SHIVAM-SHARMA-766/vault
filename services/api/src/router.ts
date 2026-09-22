// A router small enough to read. Paths are matched exactly or with a single
// trailing parameter; there is no pattern language to get wrong.

import { type LambdaEvent, type LambdaResponse, notFound } from './http.js'

export interface RouteContext {
  event: LambdaEvent
  /** The value captured by a `:param` segment, when the route has one. */
  param: string
}

export type Handler = (ctx: RouteContext) => Promise<LambdaResponse>

interface Route {
  method: string
  segments: string[]
  handler: Handler
}

export class Router {
  private readonly routes: Route[] = []

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({
      method,
      segments: path.split('/').filter(Boolean),
      handler,
    })
    return this
  }

  get = (path: string, handler: Handler) => this.add('GET', path, handler)
  post = (path: string, handler: Handler) => this.add('POST', path, handler)
  put = (path: string, handler: Handler) => this.add('PUT', path, handler)
  delete = (path: string, handler: Handler) => this.add('DELETE', path, handler)

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
