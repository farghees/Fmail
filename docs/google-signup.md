# Google sign-up, login and reset

fmail can let people create a mailbox on your domain with "Continue with Google". It is off unless you configure it.

## What it does

- **Sign-up.** The user signs in with Google, picks a UserID, and gets `<userid>@<GOOGLE_SIGNUP_DOMAIN>`. The account is **Google-only**: it has no password.
- **Login with Google.** A linked account signs in with the same button. Disabled accounts, passkey-only accounts and accounts that require a second factor are refused with their own message.
- **Password reset.** A Google-only account's reset link is always emailed to its Google address, never to an editable recovery address. This is the only way to give such an account a password.
- **Opt-in forward to Gmail.** At sign-up (and later in Settings) the user can tick "forward a copy of all incoming mail". The app registers their Google address as a Cloudflare Email Routing destination address; Cloudflare emails that address a confirmation link, and forwarding starts after the click. Mail stays in fmail either way.
- **Turnstile** protects the sign-up form when `TURNSTILE_SECRET_KEY` is set.

## Configuration

Plain variables in `wrangler.jsonc` `vars`:

| Variable | Meaning |
| --- | --- |
| `APP_HOST` | The webmail host, for example `mail.example.com`. Google is active only on this host. |
| `APP_NAME` | Name shown on that host (default `fmail`). |
| `GOOGLE_SIGNUP_DOMAIN` | Mail domain new users get, for example `example.com`. Unset keeps Google off. |
| `CF_ACCOUNT_ID` | Optional. Account that owns the forwarding destination addresses. When unset it is read from the signup domain's zone. |
| `HOST_BRANDING` | Optional JSON for extra hosts, for example `{"mail.other.com":{"appName":"Other","googleSignupDomain":"other.com"}}`. Each host gets its own app name and signup domain. |

Worker secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (`npx wrangler secret put ...`).

**Gating:** Google is active for a request only when its host equals `APP_HOST` (or a `HOST_BRANDING` host), that host has a signup domain, and both secrets exist. Otherwise `/api/auth/google/start` and `/auth/google/callback` answer 404. The redirect URI is built from the request host, so it is always `https://<host>/auth/google/callback`.

**Requirements on the data side:** `GOOGLE_SIGNUP_DOMAIN` must exist in Admin, Domains, be active, and belong to a user (normally the primary admin). Mailboxes are created through the normal account path, so license seat limits apply: sign-up always leaves two seats free for admins and stops at 50 Google accounts (`GOOGLE_SIGNUP_ACCOUNT_CAP` in `src/lib/google-auth/service.ts`).

## Google Cloud setup

1. In [Google Cloud Console](https://console.cloud.google.com), create or pick a project.
2. **OAuth consent screen** (Google Auth Platform, Branding / Audience): user type **External**; set the app name, a support email and a developer contact email; add your domain under authorized domains if asked. **Scopes:** `openid`, `email`, `profile` (all non-sensitive, so no Google verification review is needed). **Publishing status:** move it to **In production**, otherwise only listed test users can sign in.
3. **Credentials, Create credentials, OAuth client ID**, application type **Web application**.
   - Authorized JavaScript origins: `https://mail.<your-domain>`
   - Authorized redirect URIs: `https://mail.<your-domain>/auth/google/callback`
4. Copy the client ID and secret. Set them as Worker secrets (never in a file): see [INSTALL.md](../INSTALL.md), step 8.

The origin and redirect URI must match `APP_HOST` exactly (https, no trailing slash, no path on the origin).

## Check it works

```bash
curl -sI "https://mail.example.com/api/auth/google/start?purpose=signup" | grep -i '^location'
```

A `302` to `accounts.google.com` whose `redirect_uri` is your callback means it is on. A `404` means one of the three conditions above is unmet.

## Security notes

- Authorization code flow with PKCE, state and nonce; the ID token signature, issuer, audience and nonce are verified.
- The flow state and the verified Google identity live in short-lived, host-bound, single-use records and cookies.
- The Google client secret is only ever read from the Worker secret.
- Responses to anonymous users never reveal why sign-up is unavailable (capacity, seats, missing domain).
- Sign-in attempts are rate limited (HTTP 429 with `Retry-After`).
