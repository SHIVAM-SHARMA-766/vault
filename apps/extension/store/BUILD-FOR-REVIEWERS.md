# Building the Vault extension from this source

For store reviewers (addons.mozilla.org asks for source because the bundles are minified).
The build is reproducible: these steps produce the uploaded package byte for byte.

**Needs:** Linux or macOS, Node.js 20 (npm 10), and `zip`. Nothing is downloaded at build time
except the npm packages pinned in `package-lock.json`.

```sh
npm ci
npm run build --workspace @vault/crypto
npm run build --workspace @vault/core
npm run build --workspace @vault/extension
# dist/vault-extension-firefox-<version>.zip   → the AMO upload
# dist/vault-extension-chrome-<version>.zip    → the Chrome Web Store upload
sha256sum apps/extension/dist/*.zip            # compare with SHA256SUMS from the release
```

**What it is:** a password manager client for the person's own Vault server. It is
end-to-end encrypted:
- the master password derives keys in the extension (`packages/crypto`, Argon2id as
  WebAssembly assembled from `packages/crypto/argon2/argon2.wat`, PBKDF2 for older accounts);
- items are decrypted only in the extension.

**Where the code is:**
- `apps/extension/src/background.ts`: unlock, keys in `storage.session`, matching, filling.
- `apps/extension/src/popup/`: the toolbar popup (React).
- `apps/extension/src/content.ts`: the optional in-page icon and save prompt. It runs only after
  the person grants the optional all-sites permission.
- `apps/extension/scripts/build.mjs`: the manifests, an esbuild bundle and the zips. It refuses a
  manifest that grows host permissions, content scripts, `web_accessible_resources` or a
  looser policy.

**Network:** only the Vault server address the person enters at first run (an optional host
permission granted for that origin). No analytics, no remote code, and no data sent anywhere
else.

`'wasm-unsafe-eval'` in the extension policy compiles the Argon2id WebAssembly module embedded
in `background.js`. It permits no JavaScript `eval`.
