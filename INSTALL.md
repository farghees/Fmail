# Installing fmail (guide for an AI coding agent)

This guide is for an AI coding agent (Claude Code, Codex, Cursor and similar) installing fmail on a user's Cloudflare account. A human can follow it too. Everything below comes from this repository: the `package.json` scripts, `wrangler.jsonc.example`, `env.d.ts` and the source. If something here disagrees with the code, trust the code and tell the user.

fmail is one Cloudflare Worker backed by D1, R2, Queues and a Durable Object. Cloudflare Email Routing receives mail, Resend sends it, and Google OAuth (optional) lets people sign up for a mailbox.

## Rules for the agent

- **Never write a secret into a file that is committed.** `wrangler.jsonc` and `.dev.vars` are gitignored on purpose; do not remove them from `.gitignore`, and never put a secret in `wrangler.jsonc` `vars`. Secrets go in with `wrangler secret put`.
- Never print a secret, never pass one as a command-line argument (it shows up in `ps` and shell history), and never echo it back to the user. The snippets below pipe secrets through stdin with `printf` (a shell builtin) and `curl -K -`.
- Prefer that the user exports secrets in their own terminal before you start (`export RESEND_API_KEY=...`). If they paste them to you, use them only for this session's environment, and do not save them anywhere.
- **NEVER call Cloudflare's Email Routing "disable" API** (`DELETE /zones/{zone_id}/email/routing/dns`). It deletes the MX and SPF records, and inbound mail stops at once. The app itself calls it when a domain is deleted in Admin, so do not delete a mail domain unless the user asks. It also calls it when a first-run or add-domain attempt fails midway and is rolled back, but only if that attempt was the one that enabled Email Routing and the zone had no mail DNS records beforehand (`src/lib/domains/rollback.ts`); fix the cause and retry rather than improvising around it.
- Do not run destructive commands (deleting databases, buckets, DNS records, domains) unless the user asks.
- Run all commands from the repository root. Stop and report on the first failure instead of improvising.

## Step 0: Ask the user

Ask for every item before running a command. Do not guess.

1. **Domain and webmail subdomain.** The mail domain (for example `example.com`) and the webmail host (default `mail.example.com`). The domain must be a Cloudflare zone, status Active, on the account below.
2. **App name** shown in the UI (default `fmail`).
3. **Cloudflare account ID.**
4. **Cloudflare credentials**, either:
   - a **Global API Key plus the login email** (you will use it only to create scoped tokens, then tell the user to rotate it), or
   - **scoped tokens** already created with the permissions in [README.md, Prerequisites](README.md#prerequisites) (a deploy token and a runtime token; one token holding both sets also works).
5. **Resend API key** (full access) and confirmation that the sending domain is the mail domain.
6. **Google OAuth client ID and client secret**, if Google sign-up is wanted (Web application client; see [docs/google-signup.md](docs/google-signup.md)).
7. **Primary admin email**: the admin mailbox name (the part before `@`; the account becomes `<name>@<domain>`) and a separate **recovery email address**. The password is typed by the user in the browser at `/setup`. Never ask for it in chat.
8. **Feature choices:** enable Google sign-up (yes/no), and enable forward-to-Gmail (yes/no). Forwarding is an opt-in checkbox each user sees at sign-up; there is no separate on/off setting. It works when the runtime token has the account permission "Email Routing Addresses: Write". If the user says no, leave that permission off the runtime token (forwarding then reports an error and never blocks sign-up) and tell users not to tick it. If Google sign-up is off, skip every Google step below.

Derive these from the answers; later steps use them as shell variables (re-export them if your shell restarts): `DOMAIN` (example.com), `HOST` (mail.example.com), `APP_NAME`, and the account ID as `CLOUDFLARE_ACCOUNT_ID`.

## Step 1: Prerequisites and code

```bash
node -v    # must be Node.js 22.18 or newer (or 24.11+)
npm -v
git clone https://github.com/farghees/fmail.git && cd fmail
npm ci
```

Use the user's own clone URL if they forked it. Keep the `.git` directory: the build creates the AGPL source archive from `git archive HEAD`.

Set the non-secret values (use the user's answers) and authenticate Wrangler. If the user has a scoped deploy token:

```bash
export DOMAIN="example.com" HOST="mail.example.com" APP_NAME="My Mail"
export CLOUDFLARE_ACCOUNT_ID="<account id>"
export CLOUDFLARE_API_TOKEN="<deploy token>"      # the user exports this, not you, if possible
```

Define this helper once; every later Cloudflare API call uses it so the token never appears in process arguments (re-define it after changing `CLOUDFLARE_API_TOKEN`):

```bash
cf() { printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" | curl -sS -K - "$@"; }
```

If the user only has the Global API Key, use it for Step 2 only:

```bash
export DOMAIN="example.com" HOST="mail.example.com" APP_NAME="My Mail"
export CLOUDFLARE_ACCOUNT_ID="<account id>"
export CF_GLOBAL_EMAIL="<login email>"
export CF_GLOBAL_KEY="<global api key>"
```

Check access (token variant): `npx wrangler whoami` should list the account.

## Step 2 (only with a Global API Key): create scoped tokens, then rotate

Create two tokens with the exact permission groups the code needs, then continue with those and stop using the Global API Key. Save as `/tmp/fmail-mk-tokens.mjs` (outside the repository) and run it. It prints the new token values only to the files named below (mode 600), never to the terminal.

```js
// usage: node /tmp/fmail-mk-tokens.mjs <account_id> <zone_name>
import { writeFileSync } from "node:fs";
const [accountId, zoneName] = process.argv.slice(2);
const H = { "X-Auth-Email": process.env.CF_GLOBAL_EMAIL, "X-Auth-Key": process.env.CF_GLOBAL_KEY, "Content-Type": "application/json" };
const api = async (path, init) => { const r = await (await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: H, ...init })).json(); if (!r.success) throw new Error(JSON.stringify(r.errors)); return r.result; };
const zone = (await api(`/zones?name=${zoneName}`))[0]; if (!zone) throw new Error("zone not found");
const groups = await api("/user/tokens/permission_groups");
const NAMES = {
  deploy: ["Workers Scripts Write", "D1 Write", "Workers R2 Storage Write", "Queues Write", "Turnstile Sites Write", "Workers Tail Read", "Account Settings Read", "Zone Read", "DNS Write", "Workers Routes Write", "Email Routing Rules Write", "Zone Settings Write"],
  runtime: ["Zone Read", "DNS Write", "Email Routing Rules Write", "Zone Settings Write", "Email Routing Addresses Write", "Account Settings Read"],
};
const policies = (names) => {
  const pick = (scope) => names.map((n) => groups.find((g) => g.name === n && g.scopes?.includes(scope))).filter(Boolean);
  const missing = names.filter((n) => !groups.some((g) => g.name === n));
  if (missing.length) throw new Error("permission groups not found: " + missing.join(", "));
  return [
    { effect: "allow", resources: { [`com.cloudflare.api.account.${accountId}`]: "*" }, permission_groups: pick("com.cloudflare.api.account").map(({ id }) => ({ id })) },
    { effect: "allow", resources: { [`com.cloudflare.api.account.zone.${zone.id}`]: "*" }, permission_groups: pick("com.cloudflare.api.account.zone").map(({ id }) => ({ id })) },
  ].filter((p) => p.permission_groups.length);
};
for (const [kind, names] of Object.entries(NAMES)) {
  const t = await api("/user/tokens", { method: "POST", body: JSON.stringify({ name: `fmail-${kind}`, policies: policies(names) }) });
  writeFileSync(`/tmp/fmail-${kind}-token`, t.value, { mode: 0o600 });
  console.log(`created fmail-${kind}, value saved to /tmp/fmail-${kind}-token`);
}
```

```bash
node /tmp/fmail-mk-tokens.mjs "$CLOUDFLARE_ACCOUNT_ID" "$DOMAIN"
export CLOUDFLARE_API_TOKEN="$(cat /tmp/fmail-deploy-token)"
export CF_RUNTIME_TOKEN="$(cat /tmp/fmail-runtime-token)"
rm -f /tmp/fmail-mk-tokens.mjs /tmp/fmail-deploy-token /tmp/fmail-runtime-token
unset CF_GLOBAL_KEY CF_GLOBAL_EMAIL
```

If the script reports a missing permission group, list the names with `GET /user/tokens/permission_groups` and fix the name; Cloudflare occasionally renames groups, and the dashboard labels may differ ("Edit" is shown for "Write"). Tell the user to **rotate the Global API Key now** (dashboard, My Profile, API Tokens, Global API Key, Change). Verify a token:

```bash
cf https://api.cloudflare.com/client/v4/user/tokens/verify
```

(Account-owned tokens verify at `/accounts/$ACCOUNT_ID/tokens/verify`.) If the user supplied scoped tokens directly, set `CF_RUNTIME_TOKEN` to the runtime token they gave you.

## Step 3: Create the Cloudflare resources

Names must match `wrangler.jsonc.example`. The Worker is named `fmail` because the app creates Email Routing rules that target that name.

```bash
npx wrangler d1 create fmail
npx wrangler r2 bucket create fmail-raw
npx wrangler queues create fmail-inbound
npx wrangler queues create fmail-outbound
npx wrangler queues create fmail-agent
```

Get the D1 database ID (needed in Step 4):

```bash
export D1_ID="$(npx wrangler d1 list --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const x=JSON.parse(d).find(r=>r.name==="fmail");if(!x){process.exit(1)}process.stdout.write(x.uuid)})')"
echo "$D1_ID"
```

If a resource already exists, reuse it; do not delete and recreate.

- **KV:** fmail's `wrangler.jsonc` has no KV binding, so no KV namespace is needed.
- **Rate limits:** `LOGIN_RATE_LIMIT`, `DEVICE_LOGIN_RATE_LIMIT` and `AGENT_RATE_LIMIT` are declared in `wrangler.jsonc` with a `namespace_id` number. There is nothing to create; the number only has to be unique in the account. Keep `1001`, `1002`, `1003` unless the user already uses them for another Worker.

## Step 4: Fill in `wrangler.jsonc`

```bash
cp wrangler.jsonc.example wrangler.jsonc
node -e '
const fs = require("fs");
let s = fs.readFileSync("wrangler.jsonc", "utf8");
const sub = { "<YOUR_CLOUDFLARE_ACCOUNT_ID>": process.env.CLOUDFLARE_ACCOUNT_ID, "<YOUR_D1_DATABASE_ID>": process.env.D1_ID, "<mail.your-domain.com>": process.env.HOST, "<your-domain.com>": process.env.DOMAIN, "<Your App Name>": process.env.APP_NAME };
for (const [k, v] of Object.entries(sub)) { if (!v) throw new Error("missing value for " + k); s = s.split(k).join(v); }
fs.writeFileSync("wrangler.jsonc", s);
'
grep -n "<" wrangler.jsonc || true   # no <PLACEHOLDER> may remain (comments with < > are fine)
```

This uses `HOST`, `DOMAIN` and `APP_NAME` from Step 1. Then:

- Keep `APP_NAME` free of double quotes and backslashes (it is written into JSON).
- If Google sign-up is **off**, delete the `GOOGLE_SIGNUP_DOMAIN` line from `vars` (and its comment). Without it, Google routes answer 404.
- `APP_HOST` is set to the same value as the route and must equal the host people open. `APP_NAME` is the name shown on that host.
- To also serve other branded hosts from the same Worker, uncomment `HOST_BRANDING`, and add a route for each host. Optional.
- If the user does not want a custom domain yet, delete the `routes` block to use the `*.workers.dev` URL first; Google sign-up then stays off there (the host must equal `APP_HOST`).
- Leave binding names, queue names, cron triggers, the `REALTIME` Durable Object and its migration unchanged.

`wrangler.jsonc` is gitignored. Do not commit it; tell the user to back it up privately.

## Step 5: Apply the D1 migrations (remote)

```bash
npm run db:migrate:remote
```

This runs `wrangler d1 migrations apply DB --remote`. It asks for confirmation when run in a terminal; answer yes. Run it before the first deploy so credential or ID mistakes show up early.

## Step 6: Create the Turnstile widget

Turnstile protects login, first-run registration and the Google sign-up form. The **site key** is public and is baked into the build; the **secret** stays a Worker secret. Create the widget for the webmail host (needs "Turnstile Sites: Write" on the deploy token):

```bash
TS_DIR="$(mktemp -d)"; chmod 700 "$TS_DIR"
cf -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/challenges/widgets" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"fmail\",\"domains\":[\"$HOST\"],\"mode\":\"managed\"}" > "$TS_DIR/widget.json"
export NEXT_PUBLIC_TURNSTILE_SITE_KEY="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!r.success){console.error(JSON.stringify(r.errors));process.exit(1)}process.stdout.write(r.result.sitekey)' "$TS_DIR/widget.json")"
echo "site key: $NEXT_PUBLIC_TURNSTILE_SITE_KEY"
```

The widget response file also contains the secret; it is read in Step 8 and then deleted. The site key is not a secret and may be printed. Keep `NEXT_PUBLIC_TURNSTILE_SITE_KEY` exported in the same shell for Step 7, because the build reads it. If you skip Turnstile, leave it unset: the forms then have no widget and the secret is not set.

## Step 7: Deploy (with a custom domain route)

```bash
npm run deploy
```

`deploy` is `npm run build && npm run deploy:worker`. The build generates the migration bundle, writes the AGPL source archive and runs `vp build`; `deploy:worker` is `wrangler deploy`. Because `routes` in `wrangler.jsonc` has `"custom_domain": true`, Wrangler creates the DNS record and certificate for `$HOST` (needs Workers Routes, DNS and Zone read on the zone). The first custom-domain certificate can take a few minutes. Wrangler prints the `*.workers.dev` URL and the custom domain.

If the user has uncommitted changes to the repository, commit them first, otherwise `/source.tar.gz` does not match what is deployed.

## Step 8: Set the Worker secrets

The Worker exists after Step 7, so `secret put` works. Values arrive on stdin from environment variables the user provided; none is written to disk by you.

```bash
printf '%s' "$CF_RUNTIME_TOKEN"      | npx wrangler secret put CF_TOKEN
printf '%s' "$RESEND_API_KEY"        | npx wrangler secret put RESEND_API_KEY
# Google sign-up only:
printf '%s' "$GOOGLE_CLIENT_ID"      | npx wrangler secret put GOOGLE_CLIENT_ID
printf '%s' "$GOOGLE_CLIENT_SECRET"  | npx wrangler secret put GOOGLE_CLIENT_SECRET
# Turnstile secret from Step 6:
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(r.result.secret)' "$TS_DIR/widget.json" | npx wrangler secret put TURNSTILE_SECRET_KEY
rm -rf "$TS_DIR"
```

`CF_TOKEN` is the **runtime** token (Step 2 or the user's own), not the deploy token, and must not contain the word `Bearer`. Secrets can also be set as `npx wrangler secret put NAME` and typed at the prompt by the user.

Secrets take effect immediately; no redeploy is needed. If you skipped the site key in Step 6, do not set `TURNSTILE_SECRET_KEY` either (a secret without the site key makes the forms demand a token they cannot send).

## Step 9: Email Routing, catch-all to the Worker

The simplest path is the app: after Step 10, adding the mail domain in Admin, Domains with "Receive mail with: Cloudflare" enables Email Routing, publishes MX and SPF records, and creates the catch-all that sends to Worker `fmail`. If another provider's MX records exist, the app asks before replacing them.

To do it by hand now (uses `ZONE_ID` of the mail domain; the Worker must already be deployed):

```bash
ZONE_ID="$(cf "https://api.cloudflare.com/client/v4/zones?name=$DOMAIN" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).result[0].id))')"
# 1. enable Email Routing (adds the MX and SPF records)
cf -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/dns" -H "Content-Type: application/json" --data "{\"name\":\"$DOMAIN\"}"
# 2. catch-all to the Worker
cf -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/email/routing/rules/catch_all" -H "Content-Type: application/json" \
  --data '{"name":"Route all email to fmail","enabled":true,"matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["fmail"]}]}'
```

**Never call the disable endpoint** (`DELETE .../email/routing/dns`). To change the catch-all, `PUT` a new one. If enabling fails with a "MX records for another mail service" error, stop and ask the user before replacing the old MX records: doing so stops mail at the old provider.

## Step 10: First-run admin setup and the mail domain

1. Open `https://$HOST/setup`. It runs its checks (and initializes the database if Step 5 was skipped).
2. The user enters the primary domain (`$DOMAIN`), the admin mailbox name, the recovery email and a password (or chooses a passkey). **The user types the password; you never see it.**
   Leave **Enable sending** unchecked (that is Cloudflare Email Sending, which needs Workers Paid and a permission the runtime token lacks).
3. In Admin → Domains → expand `$DOMAIN`, confirm receiving is **Cloudflare Email Routing**. Then, under **Setup sending email**, switch on the **Resend** card ("Send through your Resend account."; it uses the `RESEND_API_KEY` secret) so Resend is the domain's sender. (When adding a further domain, the same choice is the **Send mail with** dropdown: pick **Resend**.) Then continue to Step 11.
4. **For Google sign-up, `GOOGLE_SIGNUP_DOMAIN` must be a domain in Admin, Domains that is active and owned by the primary admin** (sign-up creates mailboxes on it). Using the primary domain from the setup satisfies this.
5. Optional: Admin, Settings, "Default mailbox for new domains" (off by default).

## Step 11: Verify the Resend sending domain

With a full-access key, the app adds the domain to Resend, writes the records to the Cloudflare zone and asks Resend to verify (use "Check status" on the domain card). Manual path:

```bash
resend() { printf 'header = "Authorization: Bearer %s"\n' "$RESEND_API_KEY" | curl -sS -K - "$@"; }
resend -X POST https://api.resend.com/domains -H "Content-Type: application/json" --data "{\"name\":\"$DOMAIN\"}"   # prints the DNS records and the domain id
# create exactly the records it lists in Cloudflare DNS (CNAMEs must be DNS only, grey cloud), then:
resend -X POST "https://api.resend.com/domains/<domain-id>/verify"
resend https://api.resend.com/domains          # status should become "verified"
```

Verification can take several minutes. Records are typically a DKIM TXT at `resend._domainkey.<domain>` and an MX plus SPF TXT on `send.<domain>`; use exactly what Resend shows.

## Step 12: Verification checks

```bash
curl -sI "https://$HOST/" | head -1                                    # HTTP/2 200
curl -s  "https://$HOST/api/setup/status"                               # {"hasAdminAccount":true,...,"primaryDomain":{"hostname":"example.com",...}}
curl -s  "https://$HOST/manifest.webmanifest" | grep -o '"name":"[^"]*"' # your APP_NAME
curl -sI "https://$HOST/source.tar.gz" | head -1                        # 200 (AGPL source link)
dig +short MX "$DOMAIN"                                                 # route1/2/3.mx.cloudflare.net
# Google sign-up (only when enabled): a 302 to accounts.google.com whose redirect_uri is your callback
curl -s -o /dev/null -w '%{redirect_url}\n' "https://$HOST/api/auth/google/start?purpose=signup"
# the same route on any other host (for example the workers.dev URL) must be 404
curl -sI "https://fmail.<your-subdomain>.workers.dev/api/auth/google/start?purpose=signup" | head -1
# Resend
resend https://api.resend.com/domains | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>JSON.parse(d).data.forEach(x=>console.log(x.name,x.status)))'
```

Expected `redirect_uri` is `https%3A%2F%2F<HOST>%2Fauth%2Fgoogle%2Fcallback`. Then, by hand:

- [ ] `/login` shows the Turnstile widget. Log in as the admin.
- [ ] Send mail from an outside account to the admin mailbox; it arrives. Send one from fmail to an outside address; check the SPF and DKIM headers.
- [ ] If Google sign-up is on: in a private window, "Continue with Google" at `/signup`, pick a UserID, land in the inbox. Log out, then "Continue with Google" at login. Request a password reset and confirm it arrives at the Google address.
- [ ] If forwarding is on: sign-up with "forward a copy to Gmail" ticked; Cloudflare emails the Gmail address a confirmation link; after the click, new mail also reaches Gmail.
- [ ] `npx wrangler tail fmail` shows no repeating errors.
- [ ] `git status` shows no `wrangler.jsonc`, `.dev.vars` or other secret file.

## Troubleshooting

- **Google "Error 400: redirect_uri_mismatch".** The redirect URI in the Google OAuth client must be exactly `https://<HOST>/auth/google/callback` (https, no trailing slash, same host as `APP_HOST`). Add it in Google Cloud, APIs and Services, Credentials, your client, and wait a few minutes. The authorized JavaScript origin must be `https://<HOST>`. The app builds the redirect URI from the request host, so opening the site on another host (the workers.dev URL, `www`) produces a mismatch, or a 404 because Google is only active on `APP_HOST`.
- **"Access blocked: app not verified" or only some people can sign in.** The consent screen is in Testing: publish it ("In production"), or add each person as a test user. The scopes are `openid`, `email`, `profile` only.
- **`/api/auth/google/start` returns 404.** One of: the host is not `APP_HOST`, `GOOGLE_SIGNUP_DOMAIN` is unset, or `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` is missing (`npx wrangler secret list`). After changing a `vars` value, redeploy.
- **Sign-up says "Sign-up is not available right now."** `GOOGLE_SIGNUP_DOMAIN` is not an active domain in Admin, Domains, or the primary admin does not own it. Add it there. Self sign-up is also capped at 50 Google accounts (`GOOGLE_SIGNUP_ACCOUNT_CAP` in `src/lib/google-auth/service.ts`), and keeps two account seats free for admins.
- **Turnstile "Invalid domain" or "Verification failed", or a widget error code 110200.** The widget's domain list must include the exact host people use (`$HOST`). Fix it in dashboard, Turnstile, the widget, Hostname management (or `PUT /accounts/$ACCOUNT_ID/challenges/widgets/<sitekey>`), and wait a minute. If the widget is missing from the page, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` was not exported when you ran `npm run deploy`; export it and deploy again. If the widget appears but every login fails, `TURNSTILE_SECRET_KEY` belongs to a different widget than the site key.
- **Wrangler asks which account, or deploys to the wrong one.** Set `CLOUDFLARE_ACCOUNT_ID` and keep `account_id` in `wrangler.jsonc` consistent. `npx wrangler whoami` lists accounts.
- **Authentication error 10000 / 9109 in the app, or Email Routing steps fail.** `CF_TOKEN` is wrong, expired or lacks a runtime permission. Verify it (Step 2), fix it, and run `printf '%s' "$CF_RUNTIME_TOKEN" | npx wrangler secret put CF_TOKEN` again.
- **D1 error 7404 (database not found).** `database_id` in `wrangler.jsonc` is wrong or from another account. Use `npx wrangler d1 list`.
- **Inbound mail does not arrive.** The Worker must be named `fmail`; Email Routing must be enabled for the domain with the catch-all set to the Worker; `dig MX` must show Cloudflare's servers. Never fix this by disabling and re-enabling Email Routing.
- **Forwarding to Gmail stays "pending".** The user has not clicked Cloudflare's verification email yet (check spam). If it shows an error, the runtime token lacks "Email Routing Addresses: Write" or the account ID cannot be resolved; set `CF_ACCOUNT_ID` in `vars`.
- **`/source.tar.gz` missing or `source:archive` warns "not a git checkout".** The directory is not a git repository with a commit. Restore `.git`, or run `git init && git add -A && git commit -m init` (`wrangler.jsonc` and `.dev.vars` are gitignored and never enter it).
- **Resend domain stays pending.** Look for duplicate TXT records and for CNAMEs set to proxied (orange cloud); records must be DNS only.
- **`npm run build` fails with "wrangler.jsonc not found".** Run Step 4 first; the build needs the file.

## Updating

The in-app **Update** button (admin dashboard) is **not supported** with this install path: it replaces the repository's tracked tree through a GitHub workflow and expects a tracked `wrangler.jsonc`, which fmail deliberately does not ship. Leave `GITHUB_UPDATE_TOKEN` (and `GITHUB_UPDATE_REPO`, `GITHUB_UPDATE_REF`) unset. Update with `git pull` and a deploy:

```bash
git pull
npm ci
npm run db:migrate:remote
npm run deploy      # export NEXT_PUBLIC_TURNSTILE_SITE_KEY first
```

Re-check `wrangler.jsonc.example` for new bindings after an update and copy them into your private `wrangler.jsonc`.
