# 0029: The browser extension

Status: Accepted; built in stages (see ROADMAP phase 4)
Date: 2026-11-08
Phase: 4

## Context

Autofill is how a password manager is used day to day. The web app is good at managing a vault
and poor at using one: every login means opening another tab, finding the item, and copying
two values. The extension is the second client. It also changes threat A3: its code is installed
from a store or a signed file, not served by the hostname on every visit.

## Decisions

**One codebase, two browsers.** `apps/extension`, Manifest V3, built for Chrome and Firefox
from the same source. The two differ only in the manifest: Chrome runs the background as a
service worker, Firefox as an event page. It reuses `@vault/crypto` and `@vault/core`
unchanged, so every key derivation and item format is the web app's.

**It points at the customer's server.** At first run the person enters the server address. The
extension asks for host permission for **that origin only** (an optional permission, requested
at that moment), checks `/api/instance`, and stores the address. It talks to the API directly;
the API needs no CORS change because an extension's own pages are not subject to it for origins
it has permission for.

**No standing access to websites.** The base install asks for `activeTab` and `scripting`, not
for "read and change all your data on all websites". It can only touch a page when the person
clicks the toolbar button or presses the fill shortcut, and only that tab. Inline icons and
save-on-submit need a content script on every page; they come later as an **optional**
permission the person turns on.

**Where the keys live.** The background holds the unlocked state in `chrome.storage.session`:
kept in memory, never written to disk, cleared when the browser closes, and not readable by
content scripts. It holds the vault key, the tokens and the KDF parameters. Decrypted items are
cached only in the background's memory and are rebuilt from the server when it restarts. The
popup asks the background for what it shows, and is given only that.

**Page scripts never see a key.** Filling runs a small function in the page with
`chrome.scripting.executeScript`, given one username and one password. Before that, the
background checks the tab's URL against the item. Inside the page, the function checks
`location.origin` again before it writes anything, so a tab that navigated in the meantime gets
nothing. Only the top frame is filled in this stage. Cross-origin frames are never filled.

**Matching.** An item's URL matches a page when:

1. the origins are equal (scheme, host, port), the strongest match; or
2. both are `https`, and the hosts share a **registrable domain** (eTLD+1, from the Public
   Suffix List bundled in `@vault/core`, never fetched at run time). So `accounts.example.com`
   matches `www.example.com`, but `example.com.evil.io` and `examplee.com` do not.

IP addresses and single-label hosts such as `localhost` match by origin only. An `https` item
never fills an `http` page. Ties are ordered origin match first, then the most recently used
item.

**Unlock.** The same as the web app: email, master password, the secret key when the account has
one (kept in the extension's own IndexedDB under a non-extractable device key, the web app's
scheme from 0027), and a second factor. WebAuthn cannot be used from an extension page, because
the security key is bound to the server's own origin. An account whose only second factor is a
security key signs in with a recovery code, and the popup says so.

**Locking.** The idle rule is the account's own: the server policy's maximum, else 15 minutes.
A one-minute alarm compares it with the last thing the person did. Closing the browser locks it
too, because session storage goes. Lock from the popup at any time.

**Content-Security-Policy.** `script-src 'self'; object-src 'none'` for every extension page.
No remote code, no `eval`, and no code from the server.

## Stages

1. Setup, unlock, search, copy, TOTP, fill on click and by shortcut, lock. *(built)*
2. Shared collections, with the signed-grant checks of 0025. *(built)*
3. Optional all-sites permission: an inline icon in login fields, save and update on submit,
   the generator in the page.
4. Store packages: a signed Firefox add-on (AMO is free), and Chrome Web Store when the operator
   decides on its one-time developer fee. Until then, a release zip to load unpacked.
5. Passkey storage, after autofill is solid (0022 (c)).

## Shared collections (stage 2)

- The extension opens every collection this account may open, read only, and checks each grant
  with the same code as the web app (`apps/web/src/features/orgs/grants.ts`): a key whose
  signature fails against a trusted admin is not used, and the popup says how many collections
  were refused. It pins the owner on first sight, as the web app does. It does not upgrade the
  trust store to "signed only" and does no upkeep; the web app keeps doing both.
- **Hide passwords** (0015) is a policy the app keeps: such an item can be **filled** but not
  copied, and the background refuses to reveal it even when asked directly. The password still
  reaches the page that is filled. That is the point of filling, and it is policy, not
  encryption, as 0015 says.
- **Reporting:** filling a shared item is reported as `item.fill`, and copying as `item.copy`,
  in the organization's audit. A sensitive item (D12) notifies its admins.
- **Idle:** the strictest limit among the person's organizations applies, as in the web app.
- A problem loading shared collections never hides the person's own items.

## Tests

- core: matching against the Public Suffix List, including look-alikes, ports, IPs and scheme
  downgrade
- e2e: the real extension loaded into Chromium against the dev stack. Set up, unlock, find the
  item, fill a login page; a look-alike origin and a different port get nothing; lock and idle
  lock
- e2e: a shared item with passwords hidden is shown with its collection, fills, cannot be
  copied (also when asked directly), and appears in the owner's audit; a server that swaps the
  sealed key gets the collection refused
