// An OpenAPI 3.1 description generated from the routing table, so it cannot
// drift from what the server actually serves. Served at /api/openapi.json and
// committed as docs/openapi.json (a test fails when the two differ).
//
// It describes routes, authentication and errors. Request and response bodies
// are documented in services/api/README.md and the route handlers; the
// security-relevant property of nearly every body — that it is ciphertext the
// server cannot read — does not fit a schema.

import { ERROR_CODES } from './http.js'
import type { Router } from './router.js'
import { AUTH_HEADER } from './tokens.js'

const API_VERSION = '1'

export function openapi(router: Router): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const r of router.list()) {
    const path = r.path.replace(/:([a-z]+)/g, '{$1}')
    const params = [...r.path.matchAll(/:([a-z]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }))
    const op: Record<string, unknown> = {
      summary: r.summary,
      operationId: `${r.method.toLowerCase()}${r.path.replace(/^\/api/, '').replace(/[/:-]+([a-z0-9])/g, (_, c: string) => c.toUpperCase())}`,
      tags: [r.path.startsWith('/api/admin') ? 'admin' : r.path.split('/')[2] ?? 'api'],
      ...(params.length ? { parameters: params } : {}),
      ...(r.auth === 'access' ? { security: [{ bearer: [] }] } : { security: [] }),
      ...(r.permission ? { 'x-permission': r.permission } : {}),
      responses: {
        '2XX': { description: 'Success. JSON.' },
        default: { description: 'An error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    }
    ;(paths[path] ??= {})[r.method.toLowerCase()] = op
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Vault API',
      version: API_VERSION,
      description: 'Zero-knowledge password manager API. Every entry, folder and history body is ciphertext sealed in the client; the server stores and returns it without being able to read it. Routes marked x-permission also need that staff permission.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearer: { type: 'apiKey', in: 'header', name: AUTH_HEADER, description: 'Bearer <access token>. A custom header, so a cross-site request cannot send it.' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error', 'message'],
          properties: {
            error: { type: 'string', enum: Object.keys(ERROR_CODES), description: Object.entries(ERROR_CODES).map(([k, v]) => `${k}: ${v}`).join('\n') },
            message: { type: 'string', description: 'For people. Clients branch on `error`, not on this.' },
            details: { description: 'Field-level problems, when there are any.' },
            requestId: { type: 'string', description: 'Also in the x-request-id header; matches the server log.' },
          },
        },
      },
    },
    paths,
  }
}
