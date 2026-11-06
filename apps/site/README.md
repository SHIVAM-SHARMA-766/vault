# @vault/site

The public website at `/`: templates, an editable content schema with defaults, and the
renderer. The same renderer runs in two places — `scripts/build.mjs` in CI (a check build), and
the API, which renders the live site at start and whenever someone publishes from the admin
panel's website editor ([decisions/0007](../../decisions/0007-roles-and-site-editing.md)).

## Contents

| Path | Role |
|---|---|
| `templates/` | One HTML template per page, plus `partials/` |
| `content/schema.json` | Every editable field: type, limits, which page — what the admin editor shows |
| `content/defaults.json` | The built-in text, used until something is published |
| `lib/render.mjs` | Renders pages from templates and content; **escapes every value and accepts no markup** |
| `lib/content.mjs` | Validates content against the schema |
| `static/` | Stylesheet, favicon, built-in images |
| `scripts/build.mjs` | CI build: validate, render, check links |

## Contracts

- **No markup from content, ever.** The site shares an origin with the vault client, so a
  script in website text would run beside the vault. The renderer escapes everything; a
  browser test publishes `<script>` and asserts it arrives escaped.
- Templates ship in each release under `api/site/`; content lives in the database's `SYSTEM`
  partition, so a release never overwrites published text.
