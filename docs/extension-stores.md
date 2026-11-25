# Publishing the browser extension

How the operator puts the extension in the browser stores (decision
[0029](../decisions/0029-browser-extension.md), stage 4). The packages are built and checked
by the repository. Submitting needs the operator's own developer accounts.

## The packages

```sh
npm ci && npm run build
npm run package --workspace @vault/extension
ls apps/extension/dist/
#   vault-extension-chrome-<v>.zip    Chrome Web Store, Microsoft Edge Add-ons
#   vault-extension-firefox-<v>.zip   addons.mozilla.org
#   vault-extension-source-<v>.zip    source for AMO's review, with BUILD-FOR-REVIEWERS.md
#   SHA256SUMS
```

The build is **reproducible**: the source zip, built on a clean machine with the steps in
`apps/extension/store/BUILD-FOR-REVIEWERS.md`, gives the same bytes. The **Extension packages**
workflow (Actions, run by hand or on an `extension-v*` tag) builds them, and on a tag attaches
them to a draft release.

Before each submission:
1. Raise `version` in `apps/extension/package.json`. Stores refuse a version they have.
2. Run Mozilla's linter on the Firefox build: `npx web-ext lint --source-dir apps/extension/dist/firefox`.
3. Update `apps/extension/store/listing.md` if the permissions or features changed.

The listing text, permission justifications, data-use answers and privacy policy URL are in
[`apps/extension/store/listing.md`](../apps/extension/store/listing.md). The privacy policy is
[extension-privacy.md](extension-privacy.md).

## Firefox: addons.mozilla.org (free)

1. Sign in at https://addons.mozilla.org/developers/ with a Firefox account.
2. **Submit a New Add-on** → *On this site* (listed) → upload `vault-extension-firefox-<v>.zip`.
3. When asked whether the code is minified or bundled, answer yes and upload
   `vault-extension-source-<v>.zip`.
4. Paste the listing text and the privacy policy URL, then submit for review.

To distribute it yourself without a public listing, choose **On your own** instead. AMO signs
the package, and you host the `.xpi`.

## Microsoft Edge Add-ons (free)

The Chrome package runs in Edge unchanged.
1. Register at https://partner.microsoft.com/dashboard/microsoftedge/ (no fee).
2. Create a new extension and upload `vault-extension-chrome-<v>.zip`.
3. Fill in the same listing and privacy answers.

## Chrome Web Store

Publishing there needs a Chrome Web Store developer account, which has a one-time registration
fee. Whether to pay it is the operator's decision. Until then, Chrome users can load the
release zip unpacked (below), or use Edge.
1. Register at https://chrome.google.com/webstore/devconsole/.
2. **New item** → upload `vault-extension-chrome-<v>.zip`.
3. Answer *Privacy practices* with the single purpose, the permission justifications and the
   data-use answers from the listing file.

## Without a store

From a release, unzip `vault-extension-chrome-<v>.zip`, open `chrome://extensions`, turn on
**Developer mode**, then **Load unpacked**. Firefox keeps unsigned add-ons only until it
restarts, so use the AMO-signed one there.
