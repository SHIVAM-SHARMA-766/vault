// Sites known to offer sign-in codes from an authenticator app (TOTP), by
// registrable domain. The health check uses it to point out logins that could
// have a one-time code but have none saved ("2FA available").
//
// A short hand-kept list, shipped with the app: nothing is fetched, so the
// check never tells anyone which sites are in a vault. A site missing from the
// list simply gets no hint. Add a domain here when a site is known to support
// authenticator apps (not SMS-only); keep it its registrable domain.

export const TWO_FACTOR_SITES: ReadonlySet<string> = new Set([
  // Mail, accounts, cloud
  'google.com', 'gmail.com', 'youtube.com', 'microsoft.com', 'live.com', 'outlook.com', 'office.com', 'apple.com', 'icloud.com',
  'yahoo.com', 'zoho.com', 'zoho.in', 'proton.me', 'protonmail.com', 'tutanota.com', 'fastmail.com', 'aol.com', 'gmx.com', 'mail.com',
  'dropbox.com', 'box.com', 'mega.nz', 'pcloud.com', 'backblaze.com', 'wasabi.com', 'evernote.com', 'notion.so', 'onedrive.com',
  // Developer and infrastructure
  'github.com', 'gitlab.com', 'bitbucket.org', 'atlassian.com', 'atlassian.net', 'amazon.com', 'aws.amazon.com', 'oracle.com', 'cloud.oracle.com',
  'digitalocean.com', 'linode.com', 'vultr.com', 'hetzner.com', 'hetzner.cloud', 'ovh.com', 'ovhcloud.com', 'scaleway.com', 'heroku.com',
  'cloudflare.com', 'vercel.com', 'netlify.com', 'render.com', 'fly.io', 'railway.app', 'npmjs.com', 'pypi.org', 'docker.com', 'hub.docker.com',
  'rubygems.org', 'nuget.org', 'crates.io', 'packagist.org', 'sentry.io', 'datadoghq.com', 'newrelic.com', 'pagerduty.com', 'grafana.com',
  'hashicorp.com', 'terraform.io', 'jetbrains.com', 'stackoverflow.com', 'stackexchange.com', 'twilio.com', 'sendgrid.com', 'mailgun.com',
  'mailchimp.com', 'postmarkapp.com', 'namecheap.com', 'godaddy.com', 'hostinger.com', 'hostinger.in', 'porkbun.com', 'gandi.net', 'name.com',
  'dnsimple.com', 'duckdns.org', 'tailscale.com', 'zerotier.com', 'ngrok.com', 'firebase.google.com', 'supabase.com', 'mongodb.com', 'redis.com',
  'elastic.co', 'circleci.com', 'travis-ci.com', 'snyk.io', 'okta.com', 'auth0.com', 'onelogin.com', 'jumpcloud.com', 'salesforce.com',
  // Work and chat
  'slack.com', 'zoom.us', 'discord.com', 'telegram.org', 'figma.com', 'canva.com', 'trello.com', 'asana.com', 'monday.com', 'clickup.com',
  'linear.app', 'miro.com', 'airtable.com', 'hubspot.com', 'zendesk.com', 'freshworks.com', 'intercom.com', 'shopify.com', 'wordpress.com',
  'wix.com', 'squarespace.com', 'webflow.com', 'docusign.com', 'adobe.com', 'autodesk.com', 'linkedin.com', 'upwork.com', 'fiverr.com',
  // Social and media
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'reddit.com', 'pinterest.com', 'tumblr.com', 'snapchat.com', 'tiktok.com',
  'twitch.tv', 'medium.com', 'quora.com', 'mastodon.social', 'bsky.app', 'wikipedia.org', 'wikimedia.org',
  // Shopping, payments, money
  'paypal.com', 'stripe.com', 'wise.com', 'revolut.com', 'coinbase.com', 'binance.com', 'kraken.com', 'gemini.com', 'bitstamp.net',
  'crypto.com', 'kucoin.com', 'okx.com', 'bybit.com', 'wazirx.com', 'coindcx.com', 'zerodha.com', 'groww.in', 'upstox.com', 'robinhood.com',
  'etrade.com', 'fidelity.com', 'schwab.com', 'vanguard.com', 'interactivebrokers.com', 'ebay.com', 'etsy.com', 'flipkart.com', 'amazon.in',
  'payoneer.com', 'razorpay.com', 'cashfree.com',
  // Games and entertainment
  'steampowered.com', 'steamcommunity.com', 'epicgames.com', 'ea.com', 'ubisoft.com', 'battle.net', 'blizzard.com', 'nintendo.com',
  'playstation.com', 'xbox.com', 'gog.com', 'roblox.com', 'humblebundle.com', 'riotgames.com',
  // Security and privacy tools
  'bitwarden.com', '1password.com', 'lastpass.com', 'dashlane.com', 'keepersecurity.com', 'nordvpn.com', 'mullvad.net', 'protonvpn.com',
  'expressvpn.com', 'privateinternetaccess.com', 'malwarebytes.com', 'haveibeenpwned.com',
])
