# Behind a reverse proxy

Vault listens on plain HTTP (port 8080 in the image, `PORT` otherwise) and must be reached over
**HTTPS**: browsers refuse the WebCrypto it depends on anywhere else but `localhost`. The install
profiles bring Caddy, which does this on its own. Use this page when you already run another
proxy.

What every proxy must do:

1. **Terminate TLS** for your hostname, and send everything (`/`, `/app/…`, `/api/…`) to Vault.
   Vault serves the website, the app and the API from one origin, on purpose.
2. **Set `X-Forwarded-For`** to the client's address, and leave `TRUST_PROXY=true` (the default).
   Rate limits, the sign-in allow-list, activity and notifications use this address. If clients can
   reach Vault without the proxy, set `TRUST_PROXY=false`. Otherwise anyone can claim any address.
3. **Pass headers through.** Vault sends its own Content-Security-Policy, HSTS and the rest. Do not
   add a CSP that differs, and do not cache `/api/` responses.
4. **Allow request bodies of at least 1 MB**. Imports and backups post a few hundred KB.

`VAULT_HOSTNAME` must be the hostname people type. If HTTPS is not on port 443, set `SITE_ORIGIN`
(for example `https://vault.example.com:8443`).

## Caddy

```caddyfile
vault.example.com {
	reverse_proxy vault:8080
}
```

Caddy gets the certificate and sets `X-Forwarded-For` by itself. This is what `deploy/Caddyfile` does.

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name vault.example.com;
    ssl_certificate     /etc/letsencrypt/live/vault.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vault.example.com/privkey.pem;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # replace, do not append, at the edge
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
    }
}
server { listen 80; server_name vault.example.com; return 301 https://$host$request_uri; }
```

## Traefik (Docker labels)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.vault.rule=Host(`vault.example.com`)
  - traefik.http.routers.vault.entrypoints=websecure
  - traefik.http.routers.vault.tls.certresolver=letsencrypt
  - traefik.http.services.vault.loadbalancer.server.port=8080
```

Traefik sets `X-Forwarded-For`. If Traefik sits behind another proxy or load balancer, configure
its `forwardedHeaders.trustedIPs` so the client's address survives.

## HAProxy

```haproxy
frontend https
    bind :443 ssl crt /etc/haproxy/certs/vault.pem alpn h2,http/1.1
    http-request set-header X-Forwarded-For %[src]
    http-request set-header X-Forwarded-Proto https
    default_backend vault
backend vault
    server vault 127.0.0.1:8080 check inter 10s
    option httpchk GET /api/health
```

## Apache httpd

```apache
<VirtualHost *:443>
    ServerName vault.example.com
    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/vault.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/vault.example.com/privkey.pem
    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/
    RequestHeader set X-Forwarded-Proto "https"
</VirtualHost>
```

`mod_proxy` adds `X-Forwarded-For` itself.

## Cloud load balancers and tunnels

AWS ALB, Google Cloud Load Balancing, OCI Load Balancer and Cloudflare all add `X-Forwarded-For`.
With Cloudflare Tunnel, Vault sees the tunnel's address in the connection and the client in
`X-Forwarded-For`. That works with `TRUST_PROXY=true`, as long as the container is not
published on a public port as well.

## Check it

```sh
curl -sI https://vault.example.com/app/ | grep -i -E 'strict-transport|content-security'
curl -s https://vault.example.com/api/health          # {"status":"ok"}
```

Then sign in. **Settings → Security → Signed-in devices** should show your real address, not
the proxy's.
