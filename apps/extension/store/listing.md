# Store listing

Text for the Chrome Web Store and addons.mozilla.org, kept with the code so it changes with
it. Screenshots: `docs/images/extension-*.png` (1280×800).

## Name
Vault

## Summary (132 characters at most)
Fill passwords from your own Vault server. End-to-end encrypted: your vault is decrypted only on this device.

## Description
Vault is a password manager you run yourself, or that your company runs. This extension
connects to **your** Vault server and fills your logins.

- **Zero-knowledge.** Your master password never leaves the extension. Keys are derived here,
  and items are decrypted here. The server stores only ciphertext.
- **Fills only where it should.** A login fills on its own site: the same origin, or the same
  registrable domain over https. A look-alike domain gets nothing. Filling happens when you
  click the button or press Ctrl+Shift+L, in the tab you acted on.
- **No standing access to websites.** The extension touches a page only when you ask it to.
  The in-page icon and "save this login" are optional, and need a permission you grant
  separately.
- **Copy usernames, passwords and two-factor codes (TOTP).** Search your vault and your
  shared collections.
- **Locks itself** after the idle time your account sets, and when the browser closes.

You need a Vault server: your company's, a hosted one, or your own. See
https://github.com/SHIVAM-SHARMA-766/vault

## Category
Productivity (Chrome) · Privacy & Security (Firefox)

## Single purpose (Chrome)
Fill and save logins from the user's own Vault password manager server.

## Permission justifications (Chrome)
| Permission | Why |
|---|---|
| `activeTab` | Fill a login into the tab the user clicked the button in, or pressed the shortcut in. No access to any other tab. |
| `scripting` | Run the fill function in that tab, with one username and password. |
| `storage` | Keep the server address and settings, and the unlocked keys in session storage (memory only, cleared when the browser closes). |
| `alarms` | Lock the vault after the account's idle time. |
| Optional host permission (one origin) | Reach the user's own Vault server, at the address the user enters at first run. Asked for then, for that origin only. |
| Optional host permission (all sites) | Only if the user turns on the in-page icon and "save this login". Off by default. |

Remote code: **none**. Every script is in the package. The policy allows `'wasm-unsafe-eval'`
only to compile the Argon2id WebAssembly module bundled in the package.

## Data use (Chrome's privacy practices, Firefox's data collection)
- Collected by the developer: **nothing**. No analytics, no telemetry.
- The extension sends data only to the Vault server the user chose: the email address and
  proof of the password at sign-in, and encrypted items.
- Not sold, not used for anything unrelated to the extension's purpose, not used for
  creditworthiness.
- Firefox manifest: `data_collection_permissions: { required: ['none'] }`.

## Privacy policy URL
https://github.com/SHIVAM-SHARMA-766/vault/blob/main/docs/extension-privacy.md
