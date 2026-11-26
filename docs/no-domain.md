# Running Vault without buying a domain

Vault needs **HTTPS**. Browsers allow the encryption it does in the page, and passkeys, only on a
secure origin (`https://`, or `localhost` on the same machine). "Without a domain" here means
without *buying* one. You still get a real certificate, for free, in one of three ways:

| | You get | Ports open to the internet | Who can reach it | Best for |
|---|---|---|---|---|
| **[DuckDNS](#duckdns--caddy)** + Caddy | `https://<name>.duckdns.org` | 80 and 443 | anyone | a VM or a home server with a public IP |
| **[Tailscale](#tailscale)** | `https://<machine>.<tailnet>.ts.net` | none | your own devices (or anyone, with Funnel) | a family Vault at home, behind CGNAT |
| **[Cloudflare quick tunnel](#cloudflare-quick-tunnel-trying-it-only)** | a random `https://….trycloudflare.com` | none | anyone | trying Vault for an afternoon only |

## Pick the address once

Passkeys and security keys are bound to the hostname they were made on. So are the browser
extension's approval and everyone's bookmarks. If the address changes later:
- every passkey and security key has to be added again;
- every two-factor sign-in falls back to the authenticator app or recovery codes.

Choose an address you will keep. A domain you buy later can be added in front: see
[Moving to your own domain](#moving-to-your-own-domain).

## DuckDNS + Caddy

The reference instance runs this way. You need a machine whose ports 80 and 443 reach the
internet: a cloud VM, or a home server with port forwarding and a public IPv4 address. Not
behind CGNAT.

1. **Make the name.** Sign in at duckdns.org, create a subdomain, and point it at your public
   IP. Keep the token: it is the key to the name.
2. **Install.** Use the profile Caddy is already in. It gets and renews the certificate by
   itself:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/SHIVAM-SHARMA-766/vault/main/deploy/install.sh \
     | VAULT_PROFILE=personal VAULT_HOSTNAME=<name>.duckdns.org sh
   ```

3. **If your IP changes** (a home connection), update the record every five minutes. **Always
   pass `ip=`**: without it, DuckDNS uses whatever address the request came from, which is wrong
   behind a VPN or a proxy.

   ```sh
   # crontab -e
   */5 * * * * curl -fsS "https://www.duckdns.org/update?domains=<name>&token=<token>&ip=$(curl -fsS https://api.ipify.org)" >/dev/null
   ```

**The risk.** Whoever controls the DuckDNS account can point the name elsewhere and get a
certificate for it (see [KNOWN-ISSUES](KNOWN-ISSUES.md)). Such a server would not hold your
vault. It could serve a page that asks for your master password, which is what the browser
extension's origin check and passkeys protect against. Protect the DuckDNS login (it signs in
through GitHub, Google and others) with two-factor authentication.

## Tailscale

There are no open ports and no public address. The certificate is real, from Let's Encrypt,
issued for your tailnet's `ts.net` name. Free for personal use.

1. Install Tailscale on the server and on every device that will use Vault. Sign them in to the
   same tailnet. In the admin console, turn on **MagicDNS** and **HTTPS certificates** (DNS
   page).
2. Run Vault without Caddy, listening only on the machine itself:

   ```sh
   git clone https://github.com/SHIVAM-SHARMA-766/vault.git && cd vault/deploy/personal
   cp .env.example .env
   #   VAULT_HOSTNAME=<machine>.<tailnet>.ts.net
   #   BACKUP_PASSPHRASE=<16+ characters>
   docker compose -f compose.yml -f ../no-domain/local-port.yml up -d vault
   ```

   `local-port.yml` publishes the container on `127.0.0.1:8080` only, so nothing else on the
   network can reach it past Tailscale. `TRUST_PROXY=true` stays correct, because the only way
   in is the local proxy.
3. Put Tailscale in front:

   ```sh
   sudo tailscale serve --bg 8080
   ```

   Then open `https://<machine>.<tailnet>.ts.net` from any device in the tailnet.

- **Who can reach it:** only devices in your tailnet. Invite family to the tailnet, or share
  this one machine with them (Tailscale's *Share* feature).
- **For the public internet:** `sudo tailscale funnel --bg 8080` serves the same address to
  everyone, so mail links and share links work for people outside. Funnel has bandwidth limits.

## Cloudflare quick tunnel (trying it only)

```sh
docker compose -f compose.yml -f ../no-domain/local-port.yml up -d vault
cloudflared tunnel --url http://localhost:8080
```

It prints a random `https://….trycloudflare.com` address. Set that as `VAULT_HOSTNAME` and run
`docker compose … up -d vault` again.

The address changes every time the tunnel restarts, and Cloudflare offers no uptime promise for
it. Use it to look around, not to keep passwords in.

A **named** Cloudflare Tunnel is permanent and needs no open ports, but it needs a domain on
Cloudflare. See [reverse-proxy.md](reverse-proxy.md#cloud-load-balancers-and-tunnels).

## Moving to your own domain

1. Point the new name at the server and set `VAULT_HOSTNAME` to it. Caddy gets a certificate
   for it.
2. Tell everyone the new address. Sessions on the old address end.
3. People add their passkeys and security keys again on the new address (Settings → Security),
   then remove the old ones.

Nothing in the vault is re-encrypted: addresses are not part of any key.

## Check it

```sh
curl -s https://<your address>/api/health     # {"status":"ok"}
```

Then sign in. If the browser says the page is not secure, or Vault says "This browser cannot
run Vault here", the origin is not HTTPS. Look again at step 2 of the option you chose.
