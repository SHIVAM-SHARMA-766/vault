# 0007 — Staff roles, and a website edited from the admin panel

Status: Accepted
Date: 2026-11-06

## Context

[0006](0006-admin-panel.md) gave the admin panel to one kind of person: whoever is listed in
`ADMIN_EMAILS`. Two needs outgrew that:

- **More than one kind of staff.** The operator wants an admin who manages accounts, a
  marketing team who changes the website, and people who should see everything and change
  nothing.
- **The website changed only through a release.** Every word on the public site lived in
  HTML in the repository, so a headline or an image meant a commit and a deploy.

Both have a sharper edge here than in most products. The website is served from the same
origin as the vault client — the page that receives master passwords. Anything an editor
can put on the site that runs as code can reach that page. And every new kind of staff
account is one more account that, compromised, can do something.

## Decision

### Roles

| | Owner | Admin | Marketing | Viewer |
|---|---|---|---|---|
| Grant and change roles | ✓ | | | |
| Disable, delete, sign out, label accounts | ✓ | ✓ (below admin only) | | |
| Invitations, registration mode | ✓ | ✓ | | |
| Invite into a staff role | ✓ | | | |
| Edit and publish the website | ✓ | ✓ | ✓ | |
| See overview, accounts, invitations, audit | ✓ | ✓ | | ✓ |
| See the website editor | ✓ | ✓ | ✓ | ✓ |

- **Owner is configuration, not data.** It is still `ADMIN_EMAILS` on the host, turned into
  digests at start-up. A write to the database cannot create an owner; it can at most grant
  one of the lesser roles, which a database writer could do more simply by deleting rows.
- **The other roles live on the account's registry row** and are granted by an owner, either
  directly in Users or by an invitation that carries the role.
- **Rank:** an actor can act only on accounts ranked below them. An admin cannot disable or
  delete another admin or an owner. Nobody can act on an owner from the panel.
- **Every admin request re-reads the caller's role** from the profile and registry. A role
  removed is removed on the next request, not when a token expires.
- The permission table lives in one place, `services/api/src/roles.ts`, and the client hides
  what a role cannot use. The server's check is the control; the client's is courtesy.

### The website as content

The site is split into **templates** (shipped in each release), a **schema** describing
every editable field and its limits, and **content** (stored in the database, edited in the
panel). `apps/site/lib/render.mjs` combines them, and the same code runs at build time with
the default content and on the host when someone publishes.

```
admin panel ── draft ──► SYSTEM / SITE#DRAFT
             ── publish ─► SYSTEM / SITE#V#<version>   (last 30 kept)
                           SYSTEM / SITE#LIVE           → version
                           API renders templates + live content
                             └─► /srv/vault/site/v-<ts>/   then  current → v-<ts>  (atomic)
images ─────────────────► SYSTEM / MEDIA#<id> (bytes), MEDIAMETA#<id>
                             └─► /srv/vault/site/media/<id>.<ext>
```

What makes editing safe on this origin:

- **No markup from content.** Every value is HTML-escaped by the renderer. There is no
  rich-text field and no way to emit a tag. Paragraphs are split on blank lines; bold text in
  a list is its own field.
- **Links** must be a path on this site, an in-page anchor, or `https://`. Anything else is
  refused when saving and rendered as `#` if it ever reached the renderer.
- **Icons** come from a fixed set drawn in the renderer.
- **Images** must be PNG, JPEG or WebP, recognised by their bytes, at most 2 MB. SVG is
  refused because it can carry script. Caddy serves `/media/` only for names of that shape.
- **The security page is not editable**, apart from its search title and description. Its
  claims stay in code, next to the system they describe.
- The site still ships no JavaScript and is still checked at build time for inline script,
  inline style, remote resources and broken links.

Publishing renders into a new directory and swaps a symlink, so visitors never see a
half-written site, and a render that fails leaves the previous one serving. Media is shared
by every version, so rolling back never points at a missing image, and an image in use by
the live site or the draft cannot be deleted. Preview renders the current form, unsaved, and
opens it from a blob in a new tab.

Images are stored in the database rather than only on disk, so they are in the daily export
and survive a rebuilt host.

### Staff sign in like everyone else

Marketing and viewer accounts are ordinary zero-knowledge accounts with a role. No separate
password system was added; each staff member also gets an empty vault they need not use.

## Consequences

**A compromised marketing account can deface the website.** It cannot run code there, cannot
read a vault, and cannot touch accounts. Every publish is in the audit log, and any published
version can be put back in one click.

**The API now writes outside its own state directory.** `vault-api.service` gains
`ReadWritePaths=/srv/vault/site`, and that directory is created by `scripts/deploy.sh`.
The first release that carries this change needs `deploy.sh` to have run first; without it
the render fails, the pull agent's checks fail, and it rolls back.

**Request bodies may now be up to 4 MB**, for one base64 image. Every other route still
enforces its own, much smaller, limits.

**The site's text has two homes.** The defaults are in `apps/site/content/defaults.json`; the
live text is in the database. Changing a default in the repository changes nothing on a site
that has published content — edit it in the panel instead, or discard the published
versions.

**Adding an editable field is a schema change.** Add it to `schema.json` with a default in
`defaults.json` and use it in a template. Documents saved before it existed are filled from
the default, and the panel draws the new field without a client change.
