<img src="public/icon-192.png" alt="fmail" width="96" />

# fmail

A self-hosted alternative to Google Workspace that runs on Cloudflare. Custom-domain **email**, **calendar, drive, booking** and a **built-in AI agent**, with optional **Sign up with Google** so people can get a mailbox on your domain in one click.

fmail is a fork of [Mailflare](https://github.com/hieunc229/mailflare) by hieunc229, licensed AGPL-3.0. See [License and attribution](#license-and-attribution).

> Installing with an AI coding agent? Point it at [INSTALL.md](INSTALL.md). It asks you for the values it needs and runs every step.

## Prerequisites

Have these ready before you install.

1. **A domain you own**, added to Cloudflare as a zone, with the registrar's nameservers pointed at Cloudflare (zone status "Active"). The webmail will live at `https://mail.<your-domain>`.
2. **A Cloudflare account** and its **account ID** (dashboard, Workers & Pages overview, or any zone's overview page).
   - For the installation you need either your **Global API Key plus your login email**, or a **scoped API token** (preferred). If you hand over the Global API Key, use it only once, to create the scoped tokens below, then rotate it (My Profile, API Tokens, Global API Key, Change).
   - The permissions below were derived from the code: what `wrangler deploy` and the setup commands call, plus what the app's runtime `CF_TOKEN` secret calls (`src/lib/cloudflare-api.ts`, `src/lib/cloudflare-dns.ts`, `src/lib/domains/catch-all-routing.ts`, `src/lib/google-auth/forwarding.ts`).

   **Deploy token** (used by Wrangler on the installing machine, never stored in the Worker):

   | Scope | Permission | Used for |
   | --- | --- | --- |
   | Account | Workers Scripts: Write | `wrangler deploy`, cron triggers, the Durable Object migration |
   | Account | D1: Write | create the database, apply migrations |
   | Account | Workers R2 Storage: Write | create the bucket |
   | Account | Workers Tail Read | `npx wrangler tail fmail` for the verification steps |
   | Account | Queues: Write | create the three queues and attach consumers |
   | Account | Workers KV Storage: Write | not used by fmail's `wrangler.jsonc`; include only if you add a KV binding |
   | Account | Turnstile: Sites Write | create the Turnstile widget through the API |
   | Account | Account Settings: Read | Wrangler account lookup |
   | Zone (your zone) | Zone: Read | zone lookup |
   | Zone (your zone) | DNS: Write | the custom-domain record Wrangler creates |
   | Zone (your zone) | Workers Routes: Write | the custom domain route |
   | Zone (your zone) | Email Routing Rules: Write, Zone Settings: Write | only if the installer enables Email Routing and the catch-all by API instead of letting the app do it |

   **Runtime token** (stored as the Worker secret `CF_TOKEN`, used by the app to manage domains and forwarding destinations):

   | Scope | Permission | Used for |
   | --- | --- | --- |
   | Zone (every zone you connect) | Zone: Read | look up zones, read the account ID of a zone |
   | Zone (same) | DNS: Write | MX, SPF and DKIM records |
   | Zone (same) | Email Routing Rules: Write | per-address rules and the catch-all to the Worker |
   | Zone (same) | Zone Settings: Write | enabling Email Routing on the zone (`POST /zones/{id}/email/routing/dns`); Cloudflare's UI may label this "Email Routing: Edit" |
   | Account | Email Routing Addresses: Write | Gmail forwarding creates destination addresses |
   | Account | Account Settings: Read | account lookup |
   | Account | Email Sending: Write | only for outbound mail through Cloudflare itself; not needed with Resend |
3. **A Resend account** ([resend.com](https://resend.com)) with an **API key** (full access, so the app can add the domain and webhook) and your sending domain **verified**, including the DKIM, SPF and MX DNS records Resend shows. Resend must also be chosen as the domain's sender after setup: Admin → Domains → expand the domain → **Setup sending email** → **Resend** (the first-run setup does not select it). The app can add these records for you when the domain is on the same Cloudflare account.
4. **A Google Cloud OAuth client** (type **Web application**), only if you want Sign up with Google:
   - Authorized JavaScript origin: `https://mail.<your-domain>`
   - Authorized redirect URI: `https://mail.<your-domain>/auth/google/callback`
   - An OAuth consent screen: user type External, app name, support email, scopes `openid`, `email`, `profile` (nothing sensitive), and either publish the app ("In production") or add your testers while it is in "Testing".
   See [docs/google-signup.md](docs/google-signup.md).
5. **Tooling:** Node.js 22.18 or newer (or 24.11+), npm, git, and Wrangler (installed by `npm ci`; run it as `npx wrangler`).
6. **Cloudflare plan:** nothing in this repository's configuration names a paid-plan-only feature, and it can be deployed to a Free account. Only Cloudflare's own outbound **Email Sending** is gated behind the Workers Paid plan, and fmail does not need it when you send through Resend. For real use, **Workers Paid ($5/month) is recommended**: the Free plan's 10 ms CPU time per request and 3 MB Worker size limits are tight for an app of this size. Check [Cloudflare's pricing page](https://developers.cloudflare.com/workers/platform/pricing/) for your usage.

## Features

- **Email**: custom-domain mailboxes, personal or shared. Receive with Cloudflare Email Routing, send with Resend (or Amazon SES / Cloudflare).
- **Sign up with Google**: Google-only accounts (no password), login with Google, and password reset sent to the Google email. Opt-in forwarding of incoming mail to the user's Gmail, which creates a Cloudflare Email Routing destination address that the user confirms by email. Protected by Cloudflare Turnstile. See [docs/google-signup.md](docs/google-signup.md).
- **Per-host branding**: app name and Google sign-up are configured per webmail host with Worker variables (`APP_HOST`, `APP_NAME`, `GOOGLE_SIGNUP_DOMAIN`). One Worker can serve extra branded hosts through the optional `HOST_BRANDING` variable.
- **Drive** with per-account storage quotas, sharing and public links.
- **Calendar and booking**: repeating events, invitations, a public booking page.
- **AI agent**: searches mail, drafts replies and manages events. Uses Workers AI by default, or any OpenAI-compatible endpoint (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`), including OpenRouter. Also exposes an MCP server.
- **Routing rules**, webhooks, API keys, audit logs, backups, 34 languages, JMAP, a POP3 bridge (`pop3-bridge/`).
- Storage in R2, Backblaze B2 or S3. Database in D1 by default, or PostgreSQL, MySQL, Turso (see [docs/databases.md](docs/databases.md)).

## Architecture

```
 Internet mail ──► Cloudflare Email Routing ──catch-all──► Worker "fmail" ──► INBOUND_QUEUE ──► D1 (messages) + R2 (raw mail)
 Browser ─────────► https://mail.<domain> ────────────────► Worker "fmail" (vinext / React server components)
 Outbound ◄──────── OUTBOUND_QUEUE ◄── Worker ──► Resend (SES / Cloudflare optional)
 Google ◄─ OAuth code flow + PKCE ─► /api/auth/google/start, /auth/google/callback
 Cron (daily, every 5 min): backups, trash retention, reminders, cleanup
```

One Worker (`worker.ts`) serves the web app and handles email, queue and cron events. Bindings: D1 (`DB`), R2 (`BUCKET`), three Queues, a Durable Object (`REALTIME`) for live updates, Workers AI (`AI`), Images, and rate limiters. All of them are declared in `wrangler.jsonc.example`. Host-specific behavior lives in `src/lib/branding/hosts.ts` and `src/lib/google-auth/`.

## Quick start

```bash
git clone https://github.com/farghees/fmail.git
cd fmail
npm ci
cp wrangler.jsonc.example wrangler.jsonc   # fill in the <PLACEHOLDERS>; this file is gitignored
```

Then follow [INSTALL.md](INSTALL.md) step by step (create resources, migrate, set secrets, deploy). `wrangler.jsonc` and `.dev.vars` are gitignored: never commit them, and never put secrets in `vars`.

### Configuration at a glance

Plain variables in `wrangler.jsonc` `vars`:

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Public HTTPS origin of the webmail, `https://mail.example.com` |
| `APP_HOST` | Webmail host, `mail.example.com`. Branding and Google sign-up apply only here |
| `APP_NAME` | Name shown on that host (default `fmail`) |
| `GOOGLE_SIGNUP_DOMAIN` | Mail domain new Google users get, `example.com`. Unset keeps Google sign-up off |
| `CF_ACCOUNT_ID` | Optional, Cloudflare account ID for forwarding destinations and Workers AI model list |
| `HOST_BRANDING` | Optional JSON for extra hosts: `{"mail.other.com":{"appName":"Other","googleSignupDomain":"other.com"}}` |

Worker secrets (`npx wrangler secret put NAME`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, `CF_TOKEN`, `TURNSTILE_SECRET_KEY`. Build-time (public) value: `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, exported in the shell before `npm run deploy`.

Google sign-up is active only when all of these hold: the request host equals `APP_HOST` (or a `HOST_BRANDING` host), a signup domain is set for it, and both `GOOGLE_*` secrets exist. Otherwise the Google routes answer 404.

## Local development

```bash
cp .dev.vars.example .dev.vars    # gitignored; add your local values
cp wrangler.jsonc.example wrangler.jsonc
npm ci
npm run db:migrate:local
npm run dev                       # http://localhost:3000
```

Other scripts: `npm run build`, `npm run lint`, `npm run deploy` (build, then `wrangler deploy`), `npm run db:migrate:remote`. Tests run with `node --test tests/*.test.mjs`. A schema change needs a migration for each database type, see [docs/databases.md](docs/databases.md).

## Self-host with Docker

Runs as one container with SQLite and local files. No Cloudflare account needed for the server itself (Cloudflare Email Routing then forwards mail through the relay Worker in `deploy/cloudflare-email-relay`).

```bash
cp .env.docker.example .env.docker
docker compose up -d --build
```

See [docs/self-hosting.md](docs/self-hosting.md).

## Documentation

- [INSTALL.md](INSTALL.md): installation guide for an AI agent (also fine for humans)
- [Google sign-up](docs/google-signup.md)
- [Deployment and configuration](docs/deployment.md) (inherited from upstream, see the note at its top)
- [Databases](docs/databases.md), [Providers](docs/providers.md), [API](docs/api.md), [Email assistant and MCP](docs/email-assistant-and-mcp.md), [Localization](docs/localization.md), [Troubleshooting](docs/troubleshooting.md)

## License and attribution

fmail is licensed under the **GNU Affero General Public License v3.0**, see [LICENSE](LICENSE). It is a fork of [Mailflare](https://github.com/hieunc229/mailflare) by hieunc229, which is also AGPL-3.0; the upstream copyright and license text are retained. fmail adds Google sign-up, login and reset, opt-in Gmail forwarding, Turnstile hardening, configurable per-host branding, Drive quotas and an OpenRouter-compatible AI agent. Because of the AGPL, if you run a modified fmail as a network service you must offer its users the corresponding source; the app serves its own source at `/source.tar.gz` (built from your repository's `HEAD` at deploy time, so commit your changes before deploying).

fmail sets `MAILFLARE_SELF_LICENSED=1`, which unlocks features upstream sells as Pro/Team (Google sign-up depends on it); consider sponsoring upstream Mailflare.
