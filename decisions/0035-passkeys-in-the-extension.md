# 0035: Passkeys kept in Vault, used through the browser extension

Status: Accepted by the operator on 2026-11-25 ("complete the remaining work"); built
Date: 2026-11-25
Implements: [0022](0022-passkeys.md) (c) and [0029](0029-browser-extension.md) stage 5.

## Context

0022 separated three meanings of "passkeys". (a) and (b) are about signing in to Vault. (c) is
Vault **keeping passkeys for other sites**, as it keeps their passwords, which needs the browser
extension to answer `navigator.credentials` on those sites.

## Decision

**Opt-in.** The popup setting is *Save and use passkeys in Vault*. It uses the same optional
all-sites permission as the in-page features (0029, stage 3). Two scripts are registered at run
time, top frame only, never on the Vault server's own origin:

- **`passkey-page.js`** runs in the page's own world at `document_start`. It wraps
  `navigator.credentials.create()` and `get()`: a public-key request goes to Vault first, and
  anything Vault does not take goes to the browser exactly as before. Conditional mediation
  (the autofill flavour) always stays with the browser. The script holds and decides nothing.
- **`passkey-bridge.js`** runs in Vault's isolated world. It carries the request to the
  background and asks the person in a **closed** shadow root. It acts only on trusted clicks,
  and ignores clicks in the first 600 ms after the card appears, so a page cannot time a click
  onto it.

**The background decides:**
- **The origin** comes from the browser (the message sender's tab), never from the page. It
  goes into `clientDataJSON` and is checked again when the person confirms.
- **The rpId** must be the page's host or a parent domain, and not a public suffix (WebAuthn
  §5.1.3, against the bundled Public Suffix List), over https, or `localhost`. A page claiming
  another site's rpId gets `SecurityError` before anyone is asked.
- **Create:**
  - only when the site accepts ES256 and has not asked for a cross-platform authenticator;
  - an `excludeCredentials` match gives `InvalidStateError`;
  - the person chooses **Save in Vault**, or **Use another device**, which hands the request to
    the browser.
- **Get:** Vault offers the passkeys it has for that rpId (filtered by `allowCredentials`).
  With none, the browser handles the request as before. **Cancel** gives the site
  `NotAllowedError`.
- **Requests** are remembered for five minutes, per tab and origin, and used once.
- **Locked:** the card says so, with **Open Vault** and **Use another device**.

**Keys and formats** (`packages/core/src/passkey.ts`):
- ES256 keys come from WebCrypto, with 16 random bytes as the credential id.
- Attestation is `none` with a zero AAGUID.
- Flags are UP, UV (the vault is unlocked with the master password and the person confirmed),
  BE and BS (it syncs with the vault).
- The sign count is always 0: a synced passkey has no single counter, and 0 tells the site so.
- Signatures are DER-encoded.

**Storage.** A passkey lives in a login item, inside the sealed entry (`passkeys` on
`EntryContent`). It goes in this site's login for the same username, or in a new login named
after the rpId. The private key (PKCS#8) is encrypted with the rest of the item under the vault
key, so it syncs, is backed up and keeps history like everything else. The server never sees
it. Only my own items are used; shared items are not.

**The web app** lists an item's passkeys and lets the person remove one in the edit form, with a
reminder to remove it at the site too.

## Threat model

- **A malicious page** can ask for a passkey, as it can call `navigator.credentials`. It gets
  one only for its own rpId (the browser-reported origin decides), and only after the person
  clicks in Vault's card. It cannot read or click that card. A page script can see that
  `navigator.credentials` is wrapped, which says the setting is on.
- **The vault as a whole:** anyone who unlocks the vault can use its passkeys, as they can use
  its passwords. That is the point of keeping them there, and it is said in the setting.
- **The server** holds them only as ciphertext, like every other field.

## Not done here

- Passkeys in **shared** collections.
- Answering in **iframes**: an embedded sign-in uses the browser's own passkeys.
- Conditional mediation (passkeys offered in the autofill dropdown).
- Firefox's own passkey UI. The same scripts run there (`world: MAIN` needs Firefox 128, the
  minimum the add-on declares). The browser test runs in Chromium.

## Tests

- **core:** CBOR, authenticator data and flags, DER signatures checked against Node's verifier
  over 64 signatures, and the rpId rules (subdomain, parent, public suffix, http, IP,
  look-alikes).
- **API suite:** `@simplewebauthn/server`, as a relying party runs it, verifies a registration
  and a sign-in made by `createPasskey`/`assertPasskey` (multi-device, backed up). It refuses
  one signed for another origin, and one replayed against another challenge.
- **e2e** (Chromium, the extension, a relying party on `@simplewebauthn/server`):
  - the site offers a passkey, Vault asks and saves it, and the site verifies the
    registration;
  - signing in, the site verifies the assertion and gets the right user handle;
  - Cancel gives `NotAllowedError`;
  - a page claiming another rpId gets `SecurityError` and no card;
  - the passkey shows on the login item in the web app.
