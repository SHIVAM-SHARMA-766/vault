# @vault/web

The vault client and the admin panel: a React single-page app served at `/app/` from the same
origin as the API. All encryption and decryption happens here, through `@vault/crypto`; the
server only ever sees ciphertext. Screens are shown in the [user guide](../../docs/USER-GUIDE.md).

## Contents

| Path | Role |
|---|---|
| `src/App.tsx` | Picks the screen: auth screens when locked; vault, settings, import & export or admin when unlocked |
| `src/lib/session.ts` | The unlocked state (vault key in memory only), token refresh, idle lock; `lock()` also ends the server session |
| `src/lib/api.ts` | Every API call, typed; `ApiError` with the server's error code and request reference |
| `src/lib/router.tsx` | A small History-API router: `/app/`, `/app/settings`, `/app/import-export`, `/app/admin/:tab` |
| `src/features/auth/` | Sign in, register (recovery key shown once), recover with the recovery key |
| `src/features/vault/` | `model.ts` (load, seal, save with history, folders), list, detail, editor, sidebar, password health view |
| `src/features/transfer/` | Import (parse with `@vault/core`, plan, seal, upload in batches) and export (encrypted, CSV) |
| `src/features/settings/` | Master password, two-factor, recovery key, identity fingerprint, devices, activity |
| `src/features/admin/` | Overview, users, invitations, audit log, website editor — each gated by a permission |
| `src/ui/` | Shell (top bar, account menu), shared kit (toasts, copy, password input, generator, strength), icons |
| `scripts/check-csp.mjs` | Fails the build if the output would break the Content-Security-Policy |
| `Caddyfile` | How the client, site and API are served, with every security header |

## Contracts

- **Keys never reach storage.** No `localStorage`, `sessionStorage` or IndexedDB for anything
  sensitive; a reload means unlocking again.
- **Strict CSP.** No inline script or style, no `eval`, no remote origin — enforced by
  `check-csp.mjs` during `npm run build`. Icons are inline SVG for the same reason.
- **The access token travels in `x-vault-auth`**, never a cookie
  ([decisions/0004](../../decisions/0004-the-access-token-header.md)).
- Clients branch on API error **codes**, not messages.

```sh
npm run build --workspace @vault/web
VAULT_API=http://localhost:8080 npm run dev --workspace @vault/web   # against npm run dev:stack
```
