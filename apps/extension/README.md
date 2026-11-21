# Vault browser extension

Fills logins from a person's own Vault server, in Chrome and Firefox. The design and the
reasons behind it are in [decisions/0029](../../decisions/0029-browser-extension.md); this file
is how to build, load and work on it.

## Build

```sh
npm run build --workspace @vault/core --workspace @vault/crypto   # once, or after changing them
npm run build --workspace @vault/extension
```

This typechecks, bundles with esbuild, and writes:

| Path | What |
|---|---|
| `dist/chrome/` | Load unpacked in Chrome (`chrome://extensions` → Developer mode → Load unpacked) |
| `dist/firefox/` | Load in Firefox (`about:debugging` → This Firefox → Load Temporary Add-on → `manifest.json`) |
| `dist/vault-extension-*.zip` | The same, zipped for a release |

`node scripts/build.mjs --test` also writes `dist/chrome-test/`, which adds host permission for
`127.0.0.1` and `localhost` so the browser test needs no permission prompt. It is never shipped.

The build refuses a shipped manifest that adds host permissions, content scripts,
`externally_connectable`, web-accessible resources, other permissions, or a looser
Content-Security-Policy. Changing any of these means changing that check on purpose.

## Layout

| File | Role |
|---|---|
| `src/background.ts` | Holds the unlocked state (in `chrome.storage.session`), talks to the API, decrypts, matches, fills, locks |
| `src/content.ts` | The optional inline script (stage 3): icon in login fields, generate, save and update. Registered at run time, top frame only, UI in a closed shadow root |
| `src/fill.ts` | The one function that runs in a web page, injected on demand. Checks the origin again before it writes |
| `src/popup/` | The toolbar popup (React): connect, unlock, list, fill, copy |
| `src/messages.ts` | What the popup may ask the background |
| `src/api.ts` | The Vault API at the chosen server address |
| `scripts/build.mjs` | Manifests for both browsers, bundles, zips, the manifest check |
| `scripts/icons.mjs` | Renders `icons/icon.svg` to the PNG sizes |

Shared code comes from the workspace: key derivation and item encryption from
`@vault/crypto`, site matching and the bundled Public Suffix List from `@vault/core`
(`sitematch.ts`, regenerated with `node scripts/update-psl.mjs`), and the device-sealed
secret key from the web app's `lib/secretkey.ts`.

## Tests

- `packages/core/test/sitematch.test.ts`: matching, look-alikes, ports, IP addresses,
  downgrades, Public Suffix List cases
- `tests/e2e/extension.test.mjs`: the real extension in Chromium against the dev stack.
  Branded Chrome no longer loads unpacked extensions from the command line, so this test uses
  `EXT_CHROME_PATH`, `/usr/bin/chromium`, or Playwright's own Chromium (`npx playwright-core install chromium`)
