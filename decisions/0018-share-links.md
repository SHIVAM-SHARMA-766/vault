# 0018 — Share links: one item, opened without an account

Status: Accepted
Date: 2026-11-08
Builds: [0001](0001-cryptography-and-key-hierarchy.md)

## Context

People need to hand one password to someone outside Vault: a contractor, a family member, a
new colleague before their account exists. Without a way to do it, they paste it into chat.
1Password ("share item") and Bitwarden ("Send") offer a link that opens one item and then
stops working.

## Decision

**The key travels in the link's fragment, never to the server.** The browser makes a fresh
32-byte key and a 16-byte link id, seals a copy of the item with AES-256-GCM (the id bound as
associated data: `vault.share.v1:<id>`), and uploads only the ciphertext with an expiry and a
view limit. The link is `/app/s/<id>#<key>`. Browsers do not send the fragment in requests, and
the page sets `Referrer-Policy: no-referrer`; after opening, the page removes the fragment from
the address.

- **What is copied:** name, type, the type's fields, custom fields and notes, not folder, tags,
  favourite, archive state or history. Later edits are not in the copy.
- **Limits:** expiry of 1 hour, 1 day, 7 days or 30 days; views of 1, 2, 5, 10 or unlimited. They
  are fixed choices, so a link cannot be made to last forever. Each account can have up to 100
  live links, and creation is rate limited.
- **Opening is an explicit POST**, not the page load. Link previews in chat apps fetch the page
  and would otherwise use up a one-view link before the person sees it. Each open increments an
  atomic counter; the last allowed view deletes the copy. Opens are rate limited per address.
  Expired, used up, revoked and unknown links get the same 404.
- **The owner sees** each link's status (live, used up, expired, revoked) and open count in
  Settings → Security. They can revoke a live link. Every open is written to their activity
  log with the opener's address. The owner's list shows the item name sealed with their own
  vault key, so the server cannot read it there either.
- **Deleting the account deletes every live copy.**
- **Personal items only.** Sharing an organization's item outside it is an organization
  policy question, left for G4.

## Rejected

- **A password on the link (server-checked).** The server would then hold something that gates
  access, and a weak password plus the stored hash invites offline guessing. If a second factor
  is wanted, the person can send the link and a passphrase in two channels. A key-derived link
  password may come later, with the crypto decisions (D10).
- **The key on the server, "encrypted at rest".** That would make the server able to open
  every link, which breaks the zero-knowledge claim that the product rests on.
- **Opening on GET.** Rejected because of the link-preview problem above.
- **Live links that follow edits.** The link would need a key the owner's client keeps
  re-sealing to, which turns a one-off hand-over into a standing grant. Item sharing with a
  person (D11) is the right tool for that.

## Consequences

- Whoever holds the whole link can open the item until it expires or is used up. The UI says
  to send it over a channel the person trusts.
- If the link is lost, the owner cannot recover it. The key was never stored, so the dialog
  says to copy it at once.
- A server operator can delete a link or refuse to serve it, but cannot read one. A hostile
  server could serve a link more times than its limit: the limit is enforced by the server,
  not by cryptography. Recorded as threat A17.
