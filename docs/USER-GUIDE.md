# User guide

How to use Vault, screen by screen. Every screenshot is of the real product with made-up
data, taken by `npm run screenshots` (see [Keeping these screenshots current](#keeping-these-screenshots-current)).

<details>
<summary><b>Contents</b></summary>

- [How Vault keeps your data private](#how-vault-keeps-your-data-private)
- [Getting started](#getting-started)
- [The vault](#the-vault)
- [Folders and history](#folders-and-history)
- [Password health](#password-health)
- [Import and export](#import-and-export)
- [Account settings](#account-settings)
- [Devices and activity](#devices-and-activity)
- [Sharing with an organization](#sharing-with-an-organization)
- [Help and support](#help-and-support)
- [On a phone, and in dark mode](#on-a-phone-and-in-dark-mode)
- [For owners: the admin panel](#for-owners-the-admin-panel)
- [For staff: the service desk](#for-staff-the-service-desk)
- [Keyboard shortcuts](#keyboard-shortcuts)

</details>

## How Vault keeps your data private

```mermaid
flowchart LR
  you["You type your<br/>master password"] --> browser["Your browser derives keys<br/>and encrypts every entry"]
  browser -- "ciphertext only" --> server[("Server")]
  server -- "ciphertext only" --> browser
  browser --> read["Decrypted on screen,<br/>in memory only"]
```

- Your **master password never leaves the browser**. The server gets a separate key derived
  from it that cannot be turned back into it.
- **Everything is encrypted** — names, websites, usernames, notes, folders, tags — not just
  passwords. The server cannot tell which sites you have accounts on.
- There is **no password reset**, because the server could not do one. The **recovery key**
  you are shown at sign-up is the only way back if you forget the master password.

## Getting started

<img src="images/sign-in.png" alt="Sign-in screen" width="820">

1. Open `/app/` and choose **Create an account** — or open the invitation link you were
   emailed, which fills the code in. (On a brand-new server, the owner uses the setup link
   from the server's log instead; see [INSTALL.md](INSTALL.md#the-first-account).)
2. Pick a long master password. The strength meter is a guide; a passphrase of four or more
   unrelated words works well.
3. **Save the recovery key** shown next — print it or keep it in a safe place off this
   device. It is shown once and never sent to the server.
4. Sign in with your email and master password. If two-factor sign-in is on, enter the
   six-digit code from your authenticator app.

Forgot the master password? **Use your recovery key** on the sign-in screen, then set a new
master password.

## The vault

**Get started.** A new vault shows a short checklist beside the list: add or import your first
items, turn on two-factor sign-in, set up backups, and keep your recovery key safe. Steps tick
themselves off as you do them; **Hide this** puts it away.

<img src="images/vault.png" alt="The vault with GitHub open: username, password, website, a live one-time code and a hidden custom field" width="820">

| Area | What it does |
|---|---|
| Left column | All items, Favorites, Password health, your folders, and each item type |
| Middle column | The items in the current view; type to search (press <kbd>/</kbd>) |
| Right column | The open item: copy any field, reveal a password, open the website, see a live **one-time code** |

**Attach files** in the editor with **Attach a file**: scans, licence files, a recovery sheet,
up to 2 MB each. Each file is encrypted in your browser with its own key before it is uploaded,
and **Download** on the item decrypts it again. Files are kept with your item and in your
personal backups. They are not shared with the item, and not included in exports or share links.

**Add an item** with **New item**. Choose its type — fifteen of them, grouped as Everyday,
Money, Documents and Technical — and the form shows that type's own fields. The left column
lists a type once you have an item of it. Add **custom
fields** for anything else, and mark them hidden to mask them like a password.

<details>
<summary>Item types and their fields — a card, for example</summary>

<img src="images/card.png" alt="A card entry with name on card, masked number, expiry and security code" width="820">

| Type | Fields |
|---|---|
| Login | Username or email, password (with generator), website, one-time code key |
| Secure note | Notes only |
| Card | Name on card, number, expiry, security code, PIN — the brand is recognised from the number |
| Identity | Full name, email, phone, date of birth, address, ID number, company |
| Bank account | Bank, holder, account number, IFSC/routing, IBAN, type, PIN |
| SSH key | Host, public key, private key, passphrase |
| Wi-Fi | Network name, password, security |
| API credential | Service, key ID, secret or token (with generator), endpoint, scopes, expiry |
| Database | Type (PostgreSQL, MySQL…), host, port, database, username, password, connection string |
| Server | Host or IP, username, password, admin console, hosting provider |
| Software licence | Product, version, licence key, licensed to, email, purchased, expiry |
| Passport | Full name, number, country, nationality, date of birth, place of issue, issued, expiry |
| Driving licence | Full name, number, country or state, vehicle classes, date of birth, issued, expiry |
| Membership | Organization, member name, member or policy number, PIN, website, phone, expiry |
| Crypto wallet | Wallet, receiving address, recovery phrase (masked), wallet password, PIN |

Dates are written in your locale's style, and an expiry date that has passed shows
**Expired**.

</details>

<details>
<summary>Editing an item</summary>

<img src="images/editor.png" alt="The item editor" width="820">

Copying a password clears the clipboard after a short time. **Favorite** an item with the
star to pin it under Favorites.
</details>

**Archive.** An item you no longer use but want to keep: open it and choose **Archive**. It
leaves your lists, counts, search and the health check, and waits under **Archive** in the
sidebar until you **Restore** it. (Shared items cannot be archived — that would hide them from
everyone.)

**Passwords or passphrases.** The generator makes either. A passphrase is several random words
from the EFF list (six words ≈ 78 bits), easier to type on a phone or read out. Pick which one it
offers first, and its shape, in Settings → Preferences.

## Folders and history

<img src="images/folders.png" alt="Nested folders: Work contains Servers; an item shows its folder path" width="820">

- **Folders nest** up to four levels. Hover a folder for **New folder inside**, **Rename**
  and **Delete**. Deleting a folder never deletes items: they move up a level.
- A folder's view includes everything in the folders beneath it.

**History.** Every edit that changes an item keeps the previous version, encrypted like the
item itself — up to 20 per item.

<img src="images/history.png" alt="Previous versions of an entry, with the old password and a restore button" width="820">

Open **History** on an item to see when it changed and what changed; open a version to see
the old password and **Restore this version**. Restoring keeps the version it replaces, so
nothing is lost either way.

## Password health

<img src="images/health.png" alt="Password health: score 78/100, filters for weak, reused, old and unencrypted site, and the advice shown on an affected item" width="820">

**Password health** in the left column scores the passwords of your logins, Wi-Fi, databases and servers out of 100 and
lists the ones with a problem:

| Finding | Meaning | What to do |
|---|---|---|
| **Weak** | Easy to guess: short, common, a word plus a number, a keyboard run | Replace it with a generated password |
| **Reused** | The same password is on more than one item | Give each site its own |
| **Old** | Not changed in over a year | Change it at the site, then here |
| **Unencrypted site** | The saved website starts with `http://` | Use the site's `https://` address |
| **Breached** | Found in known data breaches (after **Check for breaches**) | Change it everywhere it is used |
| **Change due** | You set **Remind me to change the password** on the item (every 30, 90 or 180 days, or yearly) and the time has passed | Change it at the site, then here |
| **Seen by someone who left** | A shared item someone who has since left the organization could open | Change it at the site, then here |
| **Expired** / **Expiring soon** | A card, passport, licence, membership or API credential whose expiry date has passed, or falls within 30 days (not scored) | Renew it, or update the date |

These checks run in your browser. **Check for breaches** is the one exception, and only when you
press it: for each password it sends just the first 5 characters of its SHA-1 hash, through
your server, to Have I Been Pwned. The answer covers hundreds of passwords, and your browser
picks out the match itself. Results are forgotten when the vault locks. Your server's operator
can turn this off.

## Import and export

Open **Import & export** from the account menu (top right).

<img src="images/import.png" alt="Import screen showing a Bitwarden file read as 13 items: 9 logins, 1 card, 1 identity, 2 secure notes, 4 new folders" width="820">

**Import** reads a file in your browser and shows what it found before anything is saved.

| From | Export it as |
|---|---|
| Chrome, Edge, Brave | Settings → Passwords → Export passwords (CSV) |
| Firefox | about:logins → ⋯ → Export logins (CSV) |
| Safari | File → Export → Passwords (CSV) |
| Bitwarden | Tools → Export vault → `.json` or `.csv` (not "JSON (Encrypted)") |
| 1Password | File → Export → CSV |
| LastPass | Advanced options → Export (CSV) |
| KeePass / KeePassXC | Database → Export → CSV |
| Zoho Vault | Tools → Export Secrets (CSV) |
| A Vault encrypted export | As downloaded; you will be asked for its password |
| Anything else | A CSV with recognisable column names (name/title, url, username, password…) |

Options: **skip items already in the vault** (same name, username and website), and put
everything in a new folder named for today. Folders in the file are recreated, or reused if
you already have one with the same name. **Delete the export file afterwards** — it holds
your passwords in plain text.

**Export**

- **Encrypted export** — a backup of every item and folder, locked with a password you choose
  there (12+ characters). It can be imported on any Vault server. Keep the password apart
  from the file.
- **Plain CSV** — for moving to another password manager. Asks for your master password and
  an acknowledgement, because the file is not encrypted.

## Account settings

Account menu → **Account settings**. It has four sections, each with its own address, so a
link such as `/app/settings/security` opens the right one after you unlock.

<img src="images/settings.png" alt="Account settings, Security section: two-factor sign-in and signed-in devices" width="820">

| Section | What is in it |
|---|---|
| **Account** | Your details; delete your account (master password, two-factor code and a typed DELETE; export first); change the master password (other devices are signed out, nothing is re-encrypted, so it is instant); issue a new recovery key; add a secret key (below); your identity-key fingerprint |
| **Security** | Two-factor sign-in (TOTP with any authenticator app, plus ten single-use recovery codes); signed-in devices; security activity |
| **Preferences** | Theme, auto-lock, clipboard clearing and the password generator's defaults — see below |
| **Backups** | Your own encrypted backups, on your schedule, here or in your own storage — see below |
| **Emergency access** | People you trust to reach your vault if something happens to you |

### Secret key (optional)

**Account → Secret key → Add a secret key** mixes a random 128-bit key into your master
password. Even someone with a full copy of the server then has nothing to guess your
password against. Vault shows it once in an **Emergency Kit**: the server address, your
email, the key (`SK1-…`), and a blank line where you write your master password by hand.
Print it or write it down.

- This browser keeps the key, sealed with a device key that cannot be copied out.
- Each new browser asks for it once, at sign-in. A typo is caught before anything is sent.
- Adding or removing it signs out your other devices, like a password change. Nothing is
  re-encrypted.
- Lost it? Your recovery key still works. A reset on a browser that does not hold the secret
  key turns it off, and you can add a new one.
- Backups and offline copies made while it is on need it too. A personal backup opens with
  this browser's copy, or with the recovery key.
- If a browser that holds the key is told by the server that the account has none, sign-in
  stops. Choose *forget the secret key on this browser* only if you removed it yourself.

### Preferences

<img src="images/preferences.png" alt="Preferences: theme, auto-lock, clipboard and generator defaults" width="820">

| Setting | Choices | Default |
|---|---|---|
| Appearance | Match system · Light · Dark | Match system |
| Auto-lock | 1, 5, 15, 30 minutes, 1 or 4 hours idle | 15 minutes |
| Lock when I switch tab or window | on / off | off |
| Clear copied secrets after | 10, 30 seconds, 1 or 2 minutes, never | 30 seconds |
| Masked passwords show | the same dots for every password · one dot per character | the same dots (hides the length) |
| Hide a revealed secret again after | 10, 30 seconds, 1 minute, keep it shown | 30 seconds |
| Put new items in | No folder, or any folder (used when no folder is open) | No folder |
| Dates | as the browser does · 31/12/2026 · 12/31/2026 · 2026-12-31 | as the browser does |
| Times | as the browser does · 24-hour · 12-hour | as the browser does |
| Language | as the browser does · English · हिन्दी (Hindi) · Español (Spanish). The main screens are translated so far; the rest shows in English | as the browser does |
| Email alerts | email me when my account signs in (when the server sends mail) | on |
| Password generator | default length (8–64) and character sets | 20, all sets |

Preferences are **encrypted with your vault key** and saved on the server, so they follow you to
every device, and the server cannot read them. The one exception is the email alert switch,
which the server has to read to know whether to write to you. The server keeps only a
fingerprint of your address, so it can email you only as you sign in. Alerts about other
events, such as a share link being opened, appear in **Security activity** instead. An organization can set a shorter auto-lock than
yours; when it does, the section says so.

### Backups

**Offline copy.** At the bottom of Backups, **Download an offline copy** saves one HTML file you
can keep on a USB stick or another computer. It opens in any browser with your master password,
with no server and no network: for when this server is down or gone. It is read-only, it is as
strong as your master password at the time, and it leaves out attached files.

<img src="images/backups.png" alt="Backups: status, schedule and destination, copies and history" width="820">

Settings → **Backups** keeps your own copies of your vault, independent of the server's backups.

- **How often**: off (only **Back up now**), every day, every week on a day you pick, or every
  month on the 1st — at an hour you choose, in your time zone.
- **Where**: **on this server** (download any copy; protects against deleting something by
  mistake, not against losing the server), **your S3-compatible bucket** (AWS, R2, B2, Wasabi,
  MinIO…) or **your WebDAV folder** (Nextcloud, ownCloud, a NAS).
- **Copies to keep**: older ones are deleted at the destination. At most 10 are kept on the server.
- **History** lists every run and, when one fails, why.
- **Test restore** fetches the newest copy and opens it in your browser, proving it can be
  restored, without importing anything.

Each backup is your vault exactly as the server holds it: encrypted. It opens only with the
**master password you had when it was made**, or the recovery key from that time. If you change
your master password, older backups still need the old one.

**To restore**, download a copy (or take it from your bucket or folder), then Import & export →
choose the file → enter that master password. Items are added to your vault; nothing is
replaced. Duplicates are skipped if you leave that option on.

For S3 or WebDAV, the server keeps the secret key or password encrypted so it can back up while
you are away. Create one that can write only to that bucket or folder.

## Notifications

The **bell** at the top shows what happened while you were away: a share link opened, an
invitation, someone accepting yours (confirm them), an access request or its answer, a
check-out ending, a sensitive item opened, a scheduled backup that failed, an emergency access
request. Choose one to go where it matters, or **Mark all read**. Notifications are kept as long
as account activity (90 days unless your administrator changes it). They name people by the
label your organization gave them, never an item's name, which the server cannot read.

### Passkeys and security keys

**Settings → Security → Passkeys and security keys → Add a passkey or security key.** Use a
hardware key (YubiKey, Titan) or a passkey on your device (Windows Hello, Touch ID, Android) as
your second factor at sign-in, instead of or alongside an authenticator app. A key only answers
this server's real address, so a look-alike phishing page gets nothing. Your first second factor
comes with ten recovery codes; save them. Removing a key asks for your master password and a
second factor. Your master password still unlocks the vault: a key protects signing in.

## Devices and activity

<img src="images/devices.png" alt="Signed-in devices with this device marked, and the security activity list" width="820">

- **Signed-in devices** lists every browser signed in to your account, with the address it
  signed in from and when it was last active. Rename one (✎) to recognise it, or **Sign out
  device**. **Sign out everywhere** signs out all of them, this one included.
- **Locking** — the Lock button, the auto-lock (15 minutes idle unless you change it in
  Preferences), or closing the tab — signs this browser out on the server too.
- **Security activity** shows sign-ins and account changes from the last 90 days (your server's administrator can change how long).

If you see a device you do not recognise: sign it out, then change your master password.

## Sharing one item by link

To give one item to someone without an account (a contractor, a relative, a new colleague),
open it and choose **Link**. Pick how long the link lasts (1 hour to 30 days) and how many
times it can be opened (once, 2, 5, 10, or no limit), then **Create link** and copy it.

- The link holds its own key after the `#`. Vault never receives that key, so it cannot show
  you the link again. Copy it straight away.
- The person opens it in any browser and chooses **Open it**. A chat app's preview does not use
  up a view.
- They get a copy of the item as it was when you shared it. Later edits are not in the copy.
- **Settings → Security → Share links** shows each link (live, used up, expired, revoked) and how
  often it was opened, with **Revoke** for live ones. Every open also shows in your activity.
- Anyone who has the whole link can open it, so send it over a channel you trust.

## Sharing with an organization

Account menu → **Organizations**.

<img src="images/organizations.png" alt="Organizations: your fingerprint, an organization's members and collections" width="820">

1. **Create an organization** and add **collections** — "Finance", "Home & streaming".
2. **Invite** people by email address, and tick the **groups** they should join. They see the
   invitation when they next sign in, and **Accept**.
3. **Confirm them.** Ask them to read out the fingerprint shown at the top of their
   Organizations page — on a call or in person — and press **Confirm…** next to their name.
   Confirm only if it matches what you see. This is what stops anyone, the server included,
   from slipping in a key of their own. Confirming also adds them to the groups chosen at
   invitation, with the groups' collections.
4. Open a collection's **Access** and give confirmed members **Can view**, **Can edit** or
   **Can manage** (manage lets them share it onward). **Hide passwords** lets someone use a
   login without seeing its password in the app — a policy, not encryption.

**Share with one person.** Open an item, choose **Share**, and type the address of someone
with an account on this server. Vault makes a private space for the two of you (shown in
Organizations as a **Direct share**), moves the item into it, and invites them. Once they
accept and you confirm their fingerprint, they can open and edit it. Further items shared with
the same person go into the same space. Removing them works like any member removal.

**Share an item with a team** by opening it and choosing **Share** → a collection. It moves into the
collection, re-encrypted with the collection's key; everyone with access sees it under
**Shared** in the sidebar. **Move to my vault** takes it back.

<img src="images/shared-item.png" alt="A shared item with its collection badge, and the Shared section in the sidebar" width="820">

**Removing someone** cuts their access at once, and your app re-keys every collection they
could open (a new key, every item re-encrypted) so a copy they kept opens nothing new. If you
cannot manage one of them, it shows **Rotate key** for someone who can.

A new key does not change the passwords they already saw. Every item in those collections
is listed in **Password health** as **Seen by someone who left**, for everyone who can still
open it, until someone changes its password. Change it at the site, then in Vault, and the
mark goes.

**Groups** — "Parents", "Engineering" — let you give a whole team access to a collection at
once: create a group, add confirmed members, then in a collection's **Access** choose **Give
access to a group**. People added to the group later get the group's collections.

**Signed keys.** Every key someone shares with you in an organization is signed by its owner
or an admin the owner trusts, and your app checks the signature before using it. A collection
whose key does not check out shows **Key not trusted** and stays closed: ask an admin to share it
again. Your fingerprint now covers two keys, one for sharing and one for signing, so it changed
once when your app added the second. Admins see **Re-confirm…** next to members whose fingerprint
changed: compare it with them, as when you first confirmed them. If an organization's owner key
ever changes (for example after a recovery), you will see *The owner's key changed*; compare the
new owner's fingerprint before trusting it.

**Recovery key.** Creating an organization shows its **recovery key** once: keep it offline. If
every owner and admin ever loses access, any member can choose **Recover with the recovery
key…**, enter it, and become the owner, with every collection the key covers. The owner can
**Replace the recovery key** (the old one stops working), and the organization card shows how many
collections it covers. Collections are added to it automatically when someone who manages them
opens the organization.

**Joining one.** After you accept an invitation, the vault shows a note with your fingerprint
until an admin confirms you: read it to them on a call or in person. Once you are confirmed, it
tells you once where shared items appear.

**Asking for a collection.** Members see every collection's name, including ones they cannot
open, with **Request access** (and an optional reason). The owner and admins are notified and
find the request under **Access requests** on the organization. **Approve** gives access for
good or as a **check-out** (1 hour to 1 week), which ends by itself: the collection is then
marked for a key rotation and the person is told. **Decline** tells them too.

**Sensitive items.** Someone who manages a collection can tick **Tell the admins whenever
someone opens this** on an item. Each time a member opens, reveals or copies it, the owner and
admins get a notification. Like the activity log, this relies on each person's app reporting it.

**Policies…** (admins) can require two-factor sign-in, a minimum master password strength and a
shorter idle lock. They apply to everyone in the organization, you included; anyone who does
not meet them is told why and cannot open its collections until they do.

**Back up this organization…** (admins) downloads an encrypted file of every item in the
collections you can open, each collection as a folder, protected by a password you choose. It
opens in **Import & export**, on this server or another.

**Activity…** (admins) shows who opened, copied, edited, shared or removed what, for a year.

### Emergency access

Settings → **Emergency access**: choose someone you trust and a waiting period. After they
accept, confirm their fingerprint (they see their own fingerprint on the same page, ready to read
out to you). If they ever request access, you will see it in this section —
**Reject** it, or **Approve now**; if you do nothing, they get a read-only view of your vault
when the waiting period ends. Use this for the person who should be able to get in if something
happens to you.

<img src="images/emergency.png" alt="Emergency access in Settings: a trusted contact and the form to add one" width="820">

## The browser extension

Fill passwords without opening Vault: the extension for Chrome and Firefox
([0029](../decisions/0029-browser-extension.md)).

1. **Install.** Until it is in the stores, load it from a release: download
   `vault-extension-chrome-*.zip` or `vault-extension-firefox-*.zip` and unzip it. In
   Chrome, open `chrome://extensions`, turn on *Developer mode*, and choose *Load unpacked*.
   In Firefox, open `about:debugging` → *This Firefox* → *Load Temporary Add-on*.
2. **Connect.** Click the Vault button in the toolbar and enter your server's address, the one
   you open Vault at. The extension asks to reach that address, and no other.
3. **Unlock** with your email and master password, plus your secret key the first time if you
   have one. A second factor works with an authenticator app or a recovery code. A security
   key cannot be used from an extension.

On a login page, open the extension: logins saved for that site are listed first. Click **Fill**,
or press **Ctrl+Shift+L** (⌘⇧L on a Mac) to fill the best match without opening it. **User**,
**Pass** and **Code** copy the username, the password, or the current two-factor code.

- It fills only logins whose saved website matches the page: the same address, or the same
  site over https (`accounts.example.com` for `www.example.com`). A look-alike address gets
  nothing.
- It cannot read or change any page until you click it or press the shortcut.
- It locks after your account's idle limit (15 minutes unless your organization sets one), when
  you click **Lock**, and when the browser closes.

## Help and support

**No account yet, or locked out?** The sign-in screen has two links:

- **Request access** — tell the people who run the server who you are. If they approve, you
  get an invitation by email.
- **Lost your authenticator, or can't sign in? Ask for help** — they confirm it is really you
  (by phone or in person) and turn off two-factor sign-in so you can set it up again. Nobody
  can reset a forgotten master password; that is what the recovery key is for.

<img src="images/request-access.png" alt="The Request access form on the sign-in screen" width="820">

Your email address is kept only until the request is closed, then erased.

If the people running the server have set a support address, it is shown under the sign-in
form and on the Help & support page, and replies to any email Vault sends reach them.

**Signed in?** Account menu → **Help & support** → **New request**. Choose what it is about,
describe it, and optionally have replies emailed to you. The conversation stays on the page:
reply there, or close the request when you are done. Staff can read what you write but never
your vault — **never put a password, recovery key or code in a request.**

## On a phone, and in dark mode

The same app adapts to a phone. It follows your system's light or dark setting unless you pick
one in Settings → Preferences; on a phone, the settings sections are the chips along the top.

<p>
<img src="images/mobile-list.png" alt="The vault on a phone" width="260">
&nbsp;
<img src="images/mobile-detail.png" alt="An item on a phone" width="260">
</p>

<img src="images/vault-dark.png" alt="The vault in dark mode" width="820">

## For owners: the admin panel

Staff with a role see **Admin panel** in the account menu. What each role can do:

| | Owner | Admin | Support | Marketing | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| Overview | ✓ | ✓ | | | ✓ |
| Service desk: read tickets | ✓ | ✓ | ✓ | | ✓ |
| Service desk: reply, assign, approve access | ✓ | ✓ | ✓ | | |
| Service desk: reset two-factor for a locked-out user | ✓ | ✓ | | | |
| Invitations (copy the code, or email it) | ✓ | ✓ | ✓ | | read |
| Users: label, disable, sign out, offboard, reset 2FA, delete | ✓ | ✓ | | | read |
| Change roles | ✓ | | | | |
| Registration mode (closed / invite / open) | ✓ | ✓ | | | read |
| Policies (two-factor, password strength, auto-lock, sign-in length, log retention, share links, sign-in allow-list) | ✓ | ✓ | | | read |
| System: back up now, email templates | ✓ | ✓ | | | read |
| Website: edit text, SEO, images | ✓ | ✓ | | ✓ | read |
| Website: publish, roll back | ✓ | ✓ | | ✓ | |
| Audit log | ✓ | ✓ | | | ✓ |

<details>
<summary>Overview</summary>

<img src="images/admin.png" alt="Admin overview: accounts, encrypted items, sessions, invitations, backups, registration mode, server" width="820">

Counts, the last verified backup, the registration mode (closed, invite only, open), whether
mail is set up (with **Send test**), and the server's state. (Taken on the local development stack, which has no backups and forces
registration open — hence the two notices.)
</details>

<details>
<summary>Policies</summary>

Overview → **Policies** sets rules for every account on the server:

| Policy | Effect |
|---|---|
| Require two-factor sign-in | Accounts without it see a notice in the vault and in Settings, and are marked **Misses policy** in Users |
| Weakest master password | Sign-up and password change refuse anything weaker. Each person's app checks it — the server never sees a password — so an existing weaker password shows as a gap until it is changed |
| Longest auto-lock | Caps everyone's auto-lock choice. An organization's own limit can only shorten it further |
| Sign in again after | Ends every device's sign-in that many days after it signed in, however often it is used. Applies to devices already signed in |
| Share links | Allowed up to 30, 7 or 1 days, or turned off. When off, the **Link** button disappears; links already made keep working until they expire or are revoked |
| Allow sign-in only from | Addresses or ranges such as `203.0.113.0/24`, one per line; empty means anywhere. Sign-ins, recovery sign-ins and token refreshes from elsewhere are refused, so a device that leaves the network is signed out within 15 minutes. **Owners are exempt**, so a wrong list can always be fixed, and you cannot save a list that leaves out your own address |
| Keep account activity / audit and organization logs for | Older entries are deleted. Shortening a period deletes what is older at once (the panel warns first); lengthening keeps entries written from then on |

No policy locks anyone out: an account that misses one keeps working and is told what to do.
Every change is in the audit log.
</details>

<details>
<summary>First-run setup wizard</summary>

On a new server, the owner's first visit to the admin panel opens **Set up this server**. It
covers the name and support address, who can join (invite only is recommended), sign-in rules
(two-factor sign-in, strong master passwords, a short auto-lock), whether mail and backups work
(with a test email), and inviting people. Any step can be skipped, and **Step by step…** on the
Overview checklist opens it again.
</details>

<details>
<summary>Someone leaves: Offboard</summary>

Admin panel → **Users** → **Offboard** does everything at once: the account is disabled,
signed out on every device, and taken out of every organization. Each organization re-keys
what they could open and lists the shared passwords they could see for colleagues to change.
It is refused while the person owns an organization: hand it over or delete it first.
**Enable** undoes the disable; organizations invite them again.

**Invitations → Send again** replaces an unused invitation with a fresh code, emailed or
shown to copy. Codes are stored only as fingerprints, so the old one cannot be re-sent, and
it stops working.
</details>

<details>
<summary>Branding</summary>

Overview → **Name and support** also sets an **accent colour**, from a set that is
readable in light and dark, and a **logo** (PNG, JPEG or WebP, up to 48 KB). Both appear on the
sign-in page, at the top of the app and on share-link pages.
</details>

<details>
<summary>System: backups, emails, rate limits</summary>

Admin panel → **System**:

- **Server backups** shows how the host is set up (how often, how many kept, where, and when
  the last one ran) and has **Back up now**. The settings themselves (`BACKUP_PASSPHRASE`,
  `BACKUP_DIR`, `BACKUP_S3_*`) stay on the host, because a backup contains this database and must
  not hold its own key. Back up now is picked up by the server within a minute.
- **Email templates**: for the invitation and the new sign-in notice, set your own subject and
  a message that goes above the standard text, such as a welcome or who to ask. Links, codes and
  security advice are always included. `{server}` becomes the server's name. Use **Preview**
  to check, and **Use the standard email** to undo.
- **Rate limits** lists, in words, how often each thing may be done and what is counted (an
  address or an account), so you can tell someone why they were asked to wait.
</details>

<details>
<summary>Organizations (operator view)</summary>

<img src="images/admin-orgs.png" alt="The admin panel's organizations list, by counts" width="820">

Every organization on the server, by counts and the name its creator typed. You can delete one
(recorded in the audit log); you cannot open anything in it.
</details>

<details>
<summary>Website editor</summary>

<img src="images/admin-website.png" alt="Website editor: pages, SEO fields, share image, hero text" width="820">

Edit any page's text, search title and description, and images; **Preview**, **Save
draft**, then **Publish**. Every published version is kept and can be restored. Text is
escaped, never run, because the website shares its address with the vault.
</details>

A **Support** role works the service desk and issues invitations, and can change nothing
else.

Nobody in the admin panel — the owner included — can read anyone's vault.

## For staff: the service desk

<img src="images/desk.png" alt="The service desk queue: an access request and a support ticket, with filters" width="820">

Admin panel → **Service desk**. Filters show what needs attention, what is waiting on the
requester, and what is resolved or closed.

<img src="images/desk-ticket.png" alt="A ticket: the conversation on the left; requester, status, priority and assignment on the right" width="820">

| To | Do |
|---|---|
| Answer | Write a reply. The requester sees it, and is emailed if they asked for updates |
| Note something for colleagues | Tick **Internal note** — the requester never sees it |
| Approve an access request | **Approve and invite**: an invitation is issued (and emailed, with mail set up) and the ticket resolves |
| Help someone locked out | **Confirm it is really them first** — call them or see them. Then **Reset for this account** turns off two-factor sign-in. Admins only; recorded in the audit log |
| Track work | Status, priority, **Assign to me** |

Resolved tickets close by themselves after a week; closing erases the requester's address.

## Keyboard shortcuts

**<kbd>Ctrl</kbd> <kbd>K</kbd>** (<kbd>⌘</kbd> <kbd>K</kbd> on a Mac) opens the command palette:
type part of an item's name and press <kbd>Enter</kbd> to open it, or
<kbd>Shift</kbd> <kbd>Enter</kbd> to copy its password (cleared from the clipboard like any
copy). Commands are in the same box: *new item*, *password health*, *sort by…*, *settings*,
*lock*.

| Key | Action |
|---|---|
| <kbd>Ctrl</kbd> <kbd>K</kbd> / <kbd>⌘</kbd> <kbd>K</kbd> | Command palette |
| <kbd>/</kbd> | Search the list |
| <kbd>N</kbd> | New item |
| <kbd>J</kbd> / <kbd>K</kbd> | Next / previous item |
| <kbd>E</kbd> | Edit the open item |
| <kbd>S</kbd> | Select several items |
| <kbd>L</kbd> | Lock the vault |
| <kbd>?</kbd> | Show these shortcuts |
| <kbd>Esc</kbd> | Close the editor, then the open item |

Single-key shortcuts do nothing while you are typing in a field.

### Working with many items

- **Select** above the list puts a checkbox on each row (or press <kbd>S</kbd>). Pick items, or
  tick the box at the top for everything shown, then **Favorite**, **Move to…** a folder,
  **Archive** (or **Restore** in the Archive), or **Delete**. Items shared from an organization
  are changed in their collection, so they cannot be picked here.
- **Sort** the list by name, recently changed, or type. The **≡** button switches to compact
  rows. Both follow you to your other devices, like your other preferences.

## Keeping these screenshots current

```sh
npm run build
npm run screenshots     # starts the in-memory stack, imports a demo vault, writes docs/images/
```

The script is `scripts/screenshots.mjs`. Run it after any visible change, so this guide
never shows an older product than the one that ships.
