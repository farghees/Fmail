import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-google-auth-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		oidc: join(root, "src/lib/google-auth/oidc.ts"),
		config: join(root, "src/lib/google-auth/config.ts"),
		reserved: join(root, "src/lib/google-auth/reserved.ts"),
		flows: join(root, "src/lib/google-auth/flows.ts"),
		service: join(root, "src/lib/google-auth/service.ts"),
		hosts: join(root, "src/lib/branding/hosts.ts"),
		password: join(root, "src/lib/auth/password.ts"),
		forwarding: join(root, "src/lib/google-auth/forwarding.ts"),
		turnstile: join(root, "src/lib/auth/turnstile.ts"),
		reset: join(root, "src/lib/auth/password-reset.ts"),
		origin: join(root, "src/lib/auth/origin.ts"),
		rate: join(root, "src/lib/auth/rate-limit.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		db: join(root, "src/db/index.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*", "next", "next/*"],
	// Workers-only imports resolve to the node shim the other DB tests use.
	alias: { "@": join(root, "src"), "cloudflare:workers": join(root, "server/runtime/cloudflare-workers.ts"), "next/headers": "next/headers.js", "next/server": "next/server.js" },
	banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
	logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const oidc = await load("oidc");
const { resolveGoogleAuth } = await load("config");
const { validateSignupLocalPart } = await load("reserved");
const flows = await load("flows");
const service = await load("service");
const { getHostBranding, resolveHostBranding } = await load("hosts");
const { hashPassword, verifyPassword, canRecoverPassword, GOOGLE_ONLY_PASSWORD_HASH } = await load("password");
const forwarding = await load("forwarding");
const { verifyTurnstileToken } = await load("turnstile");
const { completePasswordReset, passwordResetRecipient } = await load("reset");
const { hasValidSessionMutationOrigin } = await load("origin");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const CLIENT_ID = "client-123.apps.googleusercontent.com";
const NOW = 1_800_000_000_000;
const b64url = (input) => Buffer.from(input).toString("base64url");

const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
const otherKeys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	if (String(input) === oidc.GOOGLE_JWKS_URL) return Response.json({ keys: [{ ...publicJwk, kid: "k1", alg: "RS256", use: "sig" }] });
	return realFetch(input, init);
};
after(() => { globalThis.fetch = realFetch; });

async function idToken(overrides = {}, signWith = keys.privateKey) {
	const claims = {
		iss: "https://accounts.google.com",
		aud: CLIENT_ID,
		sub: "google-sub-1",
		email: "Person@Gmail.com",
		email_verified: true,
		nonce: "nonce-1",
		iat: Math.floor(NOW / 1000) - 10,
		exp: Math.floor(NOW / 1000) + 3600,
		...overrides,
	};
	const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
	const body = b64url(JSON.stringify(claims));
	const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signWith, new TextEncoder().encode(`${head}.${body}`))).toString("base64url");
	return `${head}.${body}.${sig}`;
}

const rejects = (promise, code) => assert.rejects(promise, (error) => error instanceof oidc.OAuthFailure && error.code === code);

test("a valid ID token yields the verified sub and a lower-cased email", async () => {
	oidc.clearJwksCache();
	const claims = await oidc.verifyIdToken(await idToken(), CLIENT_ID, "nonce-1", NOW);
	assert.deepEqual(claims, { sub: "google-sub-1", email: "person@gmail.com", name: null });
	assert.equal((await oidc.verifyIdToken(await idToken({ name: "  Pat Person " }), CLIENT_ID, "nonce-1", NOW)).name, "Pat Person");
});

test("ID token validation rejects a wrong audience", async () => {
	await rejects(oidc.verifyIdToken(await idToken({ aud: "someone-else" }), CLIENT_ID, "nonce-1", NOW), "claims");
});

test("ID token validation rejects a wrong nonce", async () => {
	await rejects(oidc.verifyIdToken(await idToken({ nonce: "replayed" }), CLIENT_ID, "nonce-1", NOW), "nonce");
});

test("ID token validation rejects an unverified email", async () => {
	await rejects(oidc.verifyIdToken(await idToken({ email_verified: false }), CLIENT_ID, "nonce-1", NOW), "unverified");
	await rejects(oidc.verifyIdToken(await idToken({ email_verified: undefined }), CLIENT_ID, "nonce-1", NOW), "unverified");
});

test("ID token validation rejects an expired token but allows small clock skew", async () => {
	const exp = Math.floor(NOW / 1000);
	await rejects(oidc.verifyIdToken(await idToken({ exp: exp - 120 }), CLIENT_ID, "nonce-1", NOW), "claims");
	assert.equal((await oidc.verifyIdToken(await idToken({ exp: exp - 30 }), CLIENT_ID, "nonce-1", NOW)).sub, "google-sub-1");
});

test("ID token validation rejects a foreign issuer, a bad signature and malformed tokens", async () => {
	await rejects(oidc.verifyIdToken(await idToken({ iss: "https://evil.example" }), CLIENT_ID, "nonce-1", NOW), "claims");
	await rejects(oidc.verifyIdToken(await idToken({}, otherKeys.privateKey), CLIENT_ID, "nonce-1", NOW), "signature");
	await rejects(oidc.verifyIdToken("not-a-jwt", CLIENT_ID, "nonce-1", NOW), "token");
	const [head, , sig] = (await idToken()).split(".");
	await rejects(oidc.verifyIdToken(`${head}.${b64url(JSON.stringify({ aud: CLIENT_ID }))}.${sig}`, CLIENT_ID, "nonce-1", NOW), "signature");
});

test("the authorization URL uses the code flow with PKCE, state, nonce and the minimal scope", async () => {
	const config = { clientId: CLIENT_ID, clientSecret: "s", redirectUri: "https://mail.example.com/auth/google/callback" };
	const url = new URL(oidc.buildAuthUrl(config, "st", "no", await oidc.pkceChallenge("verifier")));
	assert.equal(url.origin + url.pathname, oidc.GOOGLE_AUTH_URL);
	assert.equal(url.searchParams.get("response_type"), "code");
	assert.equal(url.searchParams.get("scope"), "openid email profile");
	assert.equal(url.searchParams.get("state"), "st");
	assert.equal(url.searchParams.get("nonce"), "no");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("redirect_uri"), "https://mail.example.com/auth/google/callback");
	assert.equal(await oidc.pkceChallenge("verifier"), createHash("sha256").update("verifier").digest("base64url"));
	assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update("verifier").digest("base64url"));
});

const hostConfig = { APP_HOST: "mail.example.com", APP_NAME: "Acme Mail", GOOGLE_SIGNUP_DOMAIN: "example.com" };
const secrets = { ...hostConfig, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "secret" };

test("Google auth is active on the configured APP_HOST only, and only with both secrets", () => {
	const active = resolveGoogleAuth(secrets, "mail.example.com");
	assert.equal(active.domain, "example.com");
	assert.equal(active.redirectUri, "https://mail.example.com/auth/google/callback");
	assert.equal(resolveGoogleAuth(secrets, "MAIL.EXAMPLE.COM:443").host, "mail.example.com");
	assert.equal(resolveGoogleAuth(secrets, "example.com"), null, "the bare domain must not get it");
	assert.equal(resolveGoogleAuth(secrets, "evil.example"), null);
	assert.equal(resolveGoogleAuth(secrets, null), null);
	assert.equal(resolveGoogleAuth({ ...hostConfig, GOOGLE_CLIENT_ID: CLIENT_ID }, "mail.example.com"), null);
	assert.equal(resolveGoogleAuth({ ...hostConfig, GOOGLE_CLIENT_SECRET: "x" }, "mail.example.com"), null);
	assert.equal(resolveGoogleAuth({ ...hostConfig, GOOGLE_CLIENT_ID: " ", GOOGLE_CLIENT_SECRET: " " }, "mail.example.com"), null);
	assert.equal(resolveHostBranding("example.com", hostConfig), undefined);
	assert.deepEqual(Object.keys(getHostBranding(hostConfig)), ["mail.example.com"]);
});

test("Google auth stays off without APP_HOST or GOOGLE_SIGNUP_DOMAIN", () => {
	const keys = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "secret" };
	assert.equal(resolveGoogleAuth(keys, "mail.example.com"), null, "no host configured");
	assert.equal(resolveGoogleAuth({ ...keys, APP_HOST: "mail.example.com" }, "mail.example.com"), null, "no signup domain");
	assert.equal(resolveGoogleAuth({ ...keys, APP_HOST: "mail.example.com", GOOGLE_SIGNUP_DOMAIN: "  " }, "mail.example.com"), null);
});

test("extra hosts from HOST_BRANDING get their own signup domain, as a JSON string or an object", () => {
	const extra = { "mail.other.test": { appName: "Other", googleSignupDomain: "Other.Test" } };
	const keys = { ...hostConfig, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "secret" };
	for (const HOST_BRANDING of [extra, JSON.stringify(extra)]) {
		const other = resolveGoogleAuth({ ...keys, HOST_BRANDING }, "mail.other.test");
		assert.equal(other.domain, "other.test");
		assert.equal(other.redirectUri, "https://mail.other.test/auth/google/callback");
		assert.equal(resolveGoogleAuth({ ...keys, HOST_BRANDING }, "mail.example.com").domain, "example.com");
	}
	assert.equal(resolveGoogleAuth({ ...keys, HOST_BRANDING: "{not json" }, "mail.other.test"), null);
});

test("signup mailbox names are normalised, validated and checked against reserved names", () => {
	assert.deepEqual(validateSignupLocalPart(" Alice_B-1 "), { ok: true, value: "alice_b-1" });
	assert.deepEqual(validateSignupLocalPart("x".repeat(32)), { ok: true, value: "x".repeat(32) });
	// fmail's UserID rules: 1-32 of letters, digits, _ and -, starting with a letter or digit (no dots).
	for (const bad of ["", "  ", "a b", "-lead", "_lead", "has.dot", "x".repeat(33), "ünï", "a@b", undefined, 5]) {
		assert.equal(validateSignupLocalPart(bad).ok, false, String(bad));
	}
	for (const reserved of ["admin", "Postmaster", "ABUSE", "noreply"]) assert.equal(validateSignupLocalPart(reserved).ok, false, reserved);
});

async function fixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	const now = () => Math.floor(Date.now() / 1000);
	const user = (id, extra = {}) => {
		const row = { google_sub: null, google_email: null, reset_email: null, password_hash: hashPassword("old-password"), disabled: 0, ...extra };
		sql.prepare("INSERT INTO users (id, email, name, password_hash, google_sub, google_email, reset_email, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(id, `${id}@example.com`, id, row.password_hash, row.google_sub, row.google_email, row.reset_email, row.disabled, now());
	};
	return { env: { DB: database }, sql, user, db: getDb({ DB: database }) };
}

test("the database allows one mailbox per Google account", async (t) => {
	const { sql, user } = await fixture(t);
	user("u1", { google_sub: "sub-A" });
	user("u2", { google_sub: "sub-B" });
	user("u3");
	user("u4"); // several accounts without a sub are fine
	assert.throws(() => user("u5", { google_sub: "sub-A" }), /UNIQUE/);
	assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM users").get().n, 4);
});

test("registering refuses a Google account that already has a mailbox", async (t) => {
	const { env, user } = await fixture(t);
	user("u1", { google_sub: "sub-A" });
	const host = resolveGoogleAuth(secrets, "mail.example.com");
	const result = await service.registerGoogleMailbox(env, host, { id: "f", googleSub: "sub-A", email: "a@gmail.com", name: null }, { username: "second" });
	assert.equal(result.ok, false);
	assert.equal(result.status, 409);
	assert.match(result.error, /already has a mailbox/);
});

test("registering validates the UserID before touching accounts", async (t) => {
	const { env } = await fixture(t);
	const host = resolveGoogleAuth(secrets, "mail.example.com");
	const identity = { id: "f", googleSub: "sub-new", email: "n@gmail.com", name: null };
	assert.equal((await service.registerGoogleMailbox(env, host, identity, { username: "postmaster" })).status, 400);
	assert.equal((await service.registerGoogleMailbox(env, host, identity, { username: "has.dot" })).status, 400);
	// No example.com domain row exists in this fixture, so a valid request is unavailable rather than creating an orphan.
	assert.equal((await service.registerGoogleMailbox(env, host, identity, { username: "fine" })).status, 503);
});

test("registering creates the mailbox through account creation with the Google email as recovery address", async (t) => {
	const { env: baseEnv, sql, user } = await fixture(t);
	const env = { ...baseEnv, CF_TOKEN: "test-only", MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const routingCalls = [];
	const jwksFetch = globalThis.fetch;
	t.mock.method(globalThis, "fetch", async (url, init = {}) => {
		const parsed = new URL(url);
		if (parsed.origin !== "https://api.cloudflare.com") return jwksFetch(url, init);
		routingCalls.push(`${init.method ?? "GET"} ${parsed.pathname}`);
		return Response.json({ success: true, result: init.method === "POST" ? { id: "rule-1" } : [] });
	});
	user("owner");
	sql.prepare("UPDATE users SET role = 'admin', is_primary_admin = 1 WHERE id = 'owner'").run();
	const stamp = Math.floor(Date.now() / 1000);
	sql.prepare("INSERT INTO domains (id, user_id, zone_id, hostname, status, created_at) VALUES ('dom1', 'owner', 'zone1', 'example.com', 'active', ?)").run(stamp);
	const host = resolveGoogleAuth(secrets, "mail.example.com");
	const identity = { id: "f", googleSub: "sub-new", email: "new@gmail.com", name: "New Person" };

	const created = await service.registerGoogleMailbox(env, host, identity, { username: "Newbie" });
	assert.equal(created.ok, true, JSON.stringify(created));
	const row = sql.prepare("SELECT * FROM users WHERE id = ?").get(created.userId);
	assert.equal(row.email, "newbie@example.com");
	assert.equal(row.google_sub, "sub-new");
	assert.equal(row.reset_email, "new@gmail.com");
	assert.equal(row.role, "user");
	assert.equal(row.drive_quota_bytes, null, "the app-wide default Drive quota applies");
	assert.equal(row.google_email, "new@gmail.com");
	assert.equal(row.name, "New Person", "the Google profile name is the display name");
	assert.equal(row.password_hash, "!google-only", "no password is ever set");
	for (const attempt of ["", "!google-only", "password", "long-enough-password"]) assert.equal(verifyPassword(attempt, row.password_hash), false, `no password may log in: ${attempt}`);
	assert.equal(row.forwarding_email, null, "forwarding is off unless ticked");
	assert.equal(created.forwarding, "off");
	assert.ok(!routingCalls.some((call) => call.includes("/email/routing/addresses")), "no Cloudflare destination without opt-in");
	assert.equal(sql.prepare("SELECT local_part FROM mailboxes WHERE user_id = ?").get(created.userId).local_part, "newbie");
	assert.ok(routingCalls.some((call) => call.startsWith("POST /client/v4/zones/zone1/email/routing/rules")), "an Email Routing rule is created for the new address");

	// The same Google account cannot open a second mailbox; a taken name is reported as such.
	const again = await service.registerGoogleMailbox(env, host, identity, { username: "another" });
	assert.equal(again.status, 409);
	assert.match(again.error, /already has a mailbox/);
	const taken = await service.registerGoogleMailbox(env, host, { ...identity, googleSub: "sub-other" }, { username: "newbie" });
	assert.equal(taken.status, 409);
	assert.match(taken.error, /taken/);
});

test("OAuth requests are single use, expire, and the verified identity is bound to its host", async (t) => {
	const { env } = await fixture(t);
	const row = { purpose: "signup", host: "mail.example.com", state: "s", codeVerifier: "v", nonce: "n" };
	const token = await flows.createOauthFlow(env, row);
	assert.deepEqual(await flows.consumeOauthFlow(env, token), { purpose: "signup", host: "mail.example.com", state: "s", codeVerifier: "v", nonce: "n" });
	assert.equal(await flows.consumeOauthFlow(env, token), null, "replay is refused");
	assert.equal(await flows.consumeOauthFlow(env, "unknown-token"), null);

	const stale = await flows.createOauthFlow(env, row, Date.now() - flows.OAUTH_TTL_MS - 1000);
	assert.equal(await flows.consumeOauthFlow(env, stale), null, "an expired request is refused");

	const identityToken = await flows.createIdentity(env, { purpose: "login", host: "mail.example.com", googleSub: "sub-A", email: "a@gmail.com", name: "A" });
	assert.equal(await flows.consumeOauthFlow(env, identityToken), null, "an identity cannot be used as an OAuth request");
	const found = await flows.findIdentity(env, identityToken, "mail.example.com");
	assert.deepEqual({ googleSub: found.googleSub, email: found.email, name: found.name }, { googleSub: "sub-A", email: "a@gmail.com", name: "A" });
	assert.equal(await flows.findIdentity(env, identityToken, "evil.example"), null, "wrong host");
	assert.equal(await flows.findIdentity(env, undefined, "mail.example.com"), null);
	assert.equal(await flows.findIdentity(env, identityToken, "mail.example.com", Date.now() + flows.IDENTITY_TTL_MS + 1000), null, "expired");
	await flows.deleteIdentity(env, found.id);
	assert.equal(await flows.findIdentity(env, identityToken, "mail.example.com"), null, "deleted once used");
});

test("OAuth and identity cookies are __Host- prefixed and always Secure, Path=/ and without Domain", () => {
	assert.equal(flows.OAUTH_COOKIE, "__Host-mf_google_oauth");
	assert.equal(flows.IDENTITY_COOKIE, "__Host-mf_google_identity");
	const previous = process.env.NODE_ENV;
	for (const env of ["production", "development", "test"]) {
		process.env.NODE_ENV = env;
		const cookie = flows.flowCookie(flows.OAUTH_COOKIE, "tok", 600);
		assert.match(cookie, /^__Host-mf_google_oauth=tok;/);
		for (const attribute of ["Secure", "Path=/", "HttpOnly", "SameSite=Lax"]) assert.ok(cookie.includes(`; ${attribute}`), `${env}: ${attribute}`);
		assert.ok(!/domain=/i.test(cookie));
		assert.match(flows.clearFlowCookie(flows.IDENTITY_COOKIE), /Max-Age=0.*Secure/);
	}
	process.env.NODE_ENV = previous;
});

test("more reserved names are refused", () => {
	for (const name of ["noc", "ftp", "news", "usenet", "uucp", "help", "support", "billing", "security", "root", "system", "mail", "www", "info", "noreply"]) {
		assert.equal(validateSignupLocalPart(name).ok, false, name);
	}
});

async function signupFixture(t, { subs = 0, seatLimit = null } = {}) {
	const f = await fixture(t);
	const env = { ...f.env, CF_TOKEN: "test-only", MAILFLARE_RUNTIME: "node" };
	globalThis.__mailflareNodeEnv = env;
	t.after(() => { delete globalThis.__mailflareNodeEnv; });
	const jwksFetch = globalThis.fetch;
	const ACCOUNT = "a".repeat(32);
	const cf = { calls: [], destinations: [], failAddresses: false };
	t.mock.method(globalThis, "fetch", async (url, init = {}) => {
		const parsed = new URL(url);
		if (parsed.origin !== "https://api.cloudflare.com") return jwksFetch(url, init);
		const method = init.method ?? "GET";
		const path = parsed.pathname.replace("/client/v4", "");
		cf.calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
		if (path === "/zones/zone1") return Response.json({ success: true, result: { account: { id: ACCOUNT } } });
		if (path === `/accounts/${ACCOUNT}/email/routing/addresses`) {
			if (cf.failAddresses) return Response.json({ success: false, errors: [{ message: "denied" }] }, { status: 403 });
			if (method === "POST") {
				const created = { email: JSON.parse(init.body).email, verified: null };
				cf.destinations.push(created);
				return Response.json({ success: true, result: created });
			}
			return Response.json({ success: true, result: cf.destinations });
		}
		return Response.json({ success: true, result: method === "POST" ? { id: "rule-1" } : [] });
	});
	f.cf = cf;
	f.account = ACCOUNT;
	f.user("owner");
	f.sql.prepare("UPDATE users SET role = 'admin', is_primary_admin = 1 WHERE id = 'owner'").run();
	const stamp = Math.floor(Date.now() / 1000);
	f.sql.prepare("INSERT INTO domains (id, user_id, zone_id, hostname, status, created_at) VALUES ('dom1', 'owner', 'zone1', 'example.com', 'active', ?)").run(stamp);
	for (let i = 0; i < subs; i++) f.user(`g${i}`, { google_sub: `existing-${i}` });
	if (seatLimit !== null) {
		f.sql.prepare("INSERT INTO license_settings (id, instance_id, plan, state, features, seat_limit, updated_at) VALUES ('default', 'test', 'pro', 'active', '[]', ?, 1)").run(seatLimit);
	}
	return { ...f, env, cf, account: ACCOUNT, host: resolveGoogleAuth(secrets, "mail.example.com") };
}
const newIdentity = { id: "f", googleSub: "sub-fresh", email: "fresh@gmail.com", name: null };
const input = { username: "fresh" };

test("self sign-up stops at the cap on Google-created accounts", async (t) => {
	const cap = service.GOOGLE_SIGNUP_ACCOUNT_CAP;
	assert.equal(cap, 50);
	const f = await signupFixture(t, { subs: cap - 1 });
	assert.equal((await service.registerGoogleMailbox(f.env, f.host, newIdentity, input)).ok, true, "one below the cap still works");
	const over = await service.registerGoogleMailbox(f.env, f.host, { ...newIdentity, googleSub: "sub-over" }, { username: "over" });
	assert.deepEqual([over.ok, over.status, over.error], [false, 503, "Sign-up is currently unavailable."]);
});

test("self sign-up keeps seats free for admins and never leaks seat details", async (t) => {
	// owner + 7 = 8 used of 10: 8 + 2 reserved is not below 10, so sign-up is refused.
	const full = await signupFixture(t, { subs: 7, seatLimit: 10 });
	const refused = await service.registerGoogleMailbox(full.env, full.host, newIdentity, input);
	assert.deepEqual([refused.ok, refused.status, refused.error], [false, 503, "Sign-up is currently unavailable."]);
	assert.doesNotMatch(refused.error, /seat|license/i);
	assert.equal(full.sql.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'fresh@example.com'").get().n, 0);
});

test("self sign-up is allowed while more than the reserved seats remain", async (t) => {
	const ok = await signupFixture(t, { subs: 6, seatLimit: 10 }); // 7 used, 7 + 2 < 10
	assert.equal((await service.registerGoogleMailbox(ok.env, ok.host, newIdentity, input)).ok, true);
});

test("a soft-deleted account no longer holds its Google account: re-registering works", async (t) => {
	const f = await signupFixture(t);
	f.user("old", { google_sub: "sub-fresh", reset_email: "fresh@gmail.com" });
	f.sql.prepare("UPDATE users SET deleted_at = ? WHERE id = 'old'").run(Math.floor(Date.now() / 1000));
	const created = await service.registerGoogleMailbox(f.env, f.host, newIdentity, input);
	assert.equal(created.ok, true, JSON.stringify(created));
	assert.equal(f.sql.prepare("SELECT google_sub FROM users WHERE id = 'old'").get().google_sub, null);
	assert.equal(f.sql.prepare("SELECT google_sub FROM users WHERE id = ?").get(created.userId).google_sub, "sub-fresh");
});

test("the account-creating submit fails closed without a working rate limiter; start and callback fail open", async () => {
	const { allowGoogleAuthAttempt } = await load("rate");
	const request = new Request("https://mail.example.com/x", { headers: { "cf-connecting-ip": "203.0.113.9" } });
	const broken = { LOGIN_RATE_LIMIT: { limit: async () => { throw new Error("down"); } } };
	const limited = { LOGIN_RATE_LIMIT: { limit: async () => ({ success: false }) } };
	const fine = { LOGIN_RATE_LIMIT: { limit: async () => ({ success: true }) } };
	assert.equal(await allowGoogleAuthAttempt({}, request, { failClosed: true }), false, "unbound");
	assert.equal(await allowGoogleAuthAttempt(broken, request, { failClosed: true }), false, "error");
	assert.equal(await allowGoogleAuthAttempt(limited, request, { failClosed: true }), false, "limited");
	assert.equal(await allowGoogleAuthAttempt(fine, request, { failClosed: true }), true);
	assert.equal(await allowGoogleAuthAttempt({}, request), true, "start/callback fail open when unbound");
	assert.equal(await allowGoogleAuthAttempt(broken, request), true, "start/callback fail open on error");
	assert.equal(await allowGoogleAuthAttempt(limited, request), false);
});

test("ticking the forwarding box registers only the server-side Google email as a Cloudflare destination", async (t) => {
	const f = await signupFixture(t);
	const created = await service.registerGoogleMailbox(f.env, f.host, newIdentity, { username: "fresh", forwardToGmail: true });
	assert.equal(created.ok, true, JSON.stringify(created));
	assert.equal(created.forwarding, "pending");
	const post = f.cf.calls.find((call) => call.method === "POST" && call.path.endsWith("/email/routing/addresses"));
	assert.deepEqual(post.body, { email: "fresh@gmail.com" });
	assert.equal(post.path, `/accounts/${f.account}/email/routing/addresses`, "the account comes from the zone when CF_ACCOUNT_ID is unset");
	const row = f.sql.prepare("SELECT forwarding_email, google_email FROM users WHERE id = ?").get(created.userId);
	assert.equal(row.forwarding_email, "fresh@gmail.com");
	assert.equal(row.google_email, "fresh@gmail.com");
});

test("a Cloudflare failure still completes sign-up and reports the error state with forwarding off", async (t) => {
	const f = await signupFixture(t);
	f.cf.failAddresses = true;
	const created = await service.registerGoogleMailbox(f.env, f.host, newIdentity, { username: "fresh", forwardToGmail: true });
	assert.equal(created.ok, true, "the mailbox exists");
	assert.equal(created.forwarding, "error");
	assert.equal(f.sql.prepare("SELECT forwarding_email FROM users WHERE id = ?").get(created.userId).forwarding_email, null);
});

test("forwarding can be turned on and off, status follows Cloudflare, and an existing destination is reused", async (t) => {
	const f = await signupFixture(t);
	const created = await service.registerGoogleMailbox(f.env, f.host, newIdentity, input);
	const user = { id: created.userId, email: "fresh@example.com", googleEmail: "fresh@gmail.com" };
	const forwardingOf = () => f.sql.prepare("SELECT forwarding_email FROM users WHERE id = ?").get(created.userId).forwarding_email;

	assert.equal(await forwarding.setGoogleForwarding(f.env, user, true), "pending");
	assert.equal(forwardingOf(), "fresh@gmail.com");
	assert.equal(await forwarding.googleForwardingStatus(f.env, user.email, user.googleEmail), "pending");
	f.cf.destinations[0].verified = "2026-11-22T00:00:00Z";
	assert.equal(await forwarding.googleForwardingStatus(f.env, user.email, user.googleEmail), "verified");
	assert.equal(await forwarding.setGoogleForwarding(f.env, user, false), "off");
	assert.equal(forwardingOf(), null);
	assert.equal(await forwarding.setGoogleForwarding(f.env, user, true), "verified");
	assert.equal(f.cf.calls.filter((call) => call.method === "POST" && call.path.endsWith("/addresses")).length, 1, "the shared destination is created once");
	assert.equal(await forwarding.googleForwardingStatus(f.env, user.email, "someone-else@gmail.com"), "missing", "only the asked address is looked up");

	f.cf.failAddresses = true;
	assert.equal(await forwarding.setGoogleForwarding(f.env, user, false), "off", "turning off never needs Cloudflare");
	assert.equal(await forwarding.setGoogleForwarding(f.env, user, true), "error");
	assert.equal(forwardingOf(), null, "a failed turn-on leaves forwarding off");
});

test("Google-only accounts have no password: no input verifies, and only the emailed reset may set one", async (t) => {
	assert.equal(GOOGLE_ONLY_PASSWORD_HASH, "!google-only");
	for (const attempt of ["", "!google-only", "x".repeat(72)]) assert.equal(verifyPassword(attempt, GOOGLE_ONLY_PASSWORD_HASH), false);
	assert.equal(canRecoverPassword(GOOGLE_ONLY_PASSWORD_HASH, "sub"), true);
	assert.equal(canRecoverPassword(GOOGLE_ONLY_PASSWORD_HASH, null), false, "needs a stored sub");
	assert.equal(canRecoverPassword("!passkey-only", "sub"), false, "passkey-only accounts stay excluded");
	assert.equal(canRecoverPassword(hashPassword("a-password"), null), true);

	const { env, sql, user } = await fixture(t);
	user("goog", { google_sub: "sub-G", google_email: "g@gmail.com", reset_email: "g@gmail.com", password_hash: GOOGLE_ONLY_PASSWORD_HASH });
	user("passkey", { google_sub: "sub-K", reset_email: "k@gmail.com", password_hash: "!passkey-only" });
	const sha = async (value) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
	const stamp = Math.floor(Date.now() / 1000);
	for (const [id, userId] of [["t1", "goog"], ["t2", "passkey"]]) {
		sql.prepare("INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, await sha(`tok-${id}`), stamp + 1800, stamp);
	}
	const request = new Request("https://mail.example.com/api/auth/password-reset/confirm", { method: "POST" });
	assert.deepEqual(await completePasswordReset(env, "tok-t2", "brand-new-password", request), { ok: false, error: "This reset link is invalid or has expired. Request a new one." });
	assert.equal(sql.prepare("SELECT password_hash FROM users WHERE id = 'passkey'").get().password_hash, "!passkey-only");
	assert.deepEqual(await completePasswordReset(env, "tok-t1", "brand-new-password", request), { ok: true });
	assert.equal(verifyPassword("brand-new-password", sql.prepare("SELECT password_hash FROM users WHERE id = 'goog'").get().password_hash), true);
});

test("Turnstile is skipped without the secret and enforced with it", async (t) => {
	const request = new Request("https://mail.example.com/x");
	assert.equal(await verifyTurnstileToken({}, request, undefined), true, "no TURNSTILE_SECRET_KEY: skipped");
	assert.equal(await verifyTurnstileToken({ TURNSTILE_SECRET_KEY: " " }, request, undefined), true);
	assert.equal(await verifyTurnstileToken({ TURNSTILE_SECRET_KEY: "s" }, request, undefined), false, "secret set: a token is required");
	assert.equal(await verifyTurnstileToken({ TURNSTILE_SECRET_KEY: "s" }, request, ""), false);
	t.mock.method(globalThis, "fetch", async (url) => {
		assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
		return Response.json({ success: true });
	});
	assert.equal(await verifyTurnstileToken({ TURNSTILE_SECRET_KEY: "s" }, request, "good-token"), true);
});

test("a Google-only account's reset link always goes to its Google email, never the editable recovery email", () => {
	const googleOnly = { passwordHash: GOOGLE_ONLY_PASSWORD_HASH, resetEmail: "edited@attacker.test", googleEmail: "real@gmail.com" };
	assert.equal(passwordResetRecipient(googleOnly), "real@gmail.com");
	assert.equal(passwordResetRecipient({ ...googleOnly, googleEmail: null }), null, "no Google email: no link, the recovery email is ignored");
	const withPassword = { passwordHash: hashPassword("a-password"), resetEmail: "backup@example.test", googleEmail: "real@gmail.com" };
	assert.equal(passwordResetRecipient(withPassword), "backup@example.test", "other accounts keep using their recovery email");
	assert.equal(passwordResetRecipient({ ...withPassword, resetEmail: null }), null);
});

test("Google login is refused for disabled, passkey-only and second-factor accounts, each with its own code", () => {
	const ok = { disabled: false, passwordHash: GOOGLE_ONLY_PASSWORD_HASH, requireSecondFactor: false, totpEnabled: false };
	assert.equal(service.googleLoginBlock(ok), null);
	assert.equal(service.googleLoginBlock({ ...ok, passwordHash: hashPassword("pw") }), null, "a Google account that later got a password still works");
	assert.equal(service.googleLoginBlock({ ...ok, disabled: true }), "disabled");
	assert.equal(service.googleLoginBlock({ ...ok, passwordHash: "!passkey-only" }), "passkey", "passkey recovery or password removal makes the account passkey-only");
	assert.equal(service.googleLoginBlock({ ...ok, requireSecondFactor: true }), "mfa");
	assert.equal(service.googleLoginBlock({ ...ok, totpEnabled: true }), "mfa");
	const en = JSON.parse(readFileSync(join(root, "src/lib/i18n/en.json"), "utf8"));
	for (const code of ["disabled", "passkey", "mfa"]) assert.ok(en[`auth.google.error.${code}`], code);
	assert.ok(new Set(["disabled", "passkey", "mfa"].map((code) => en[`auth.google.error.${code}`])).size === 3, "distinct messages");
	assert.match(readFileSync(join(root, "src/components/auth/google-button.tsx"), "utf8"), /"passkey", "mfa"/);
});

test("accounts created with Google may forward only to their Google email through the older settings routes", () => {
	const google = { googleSub: "sub", googleEmail: "Real@Gmail.com" };
	assert.equal(service.googleForwardingAllowed(google, null), true, "off");
	assert.equal(service.googleForwardingAllowed(google, undefined), true, "unchanged");
	assert.equal(service.googleForwardingAllowed(google, "real@gmail.com"), true);
	assert.equal(service.googleForwardingAllowed(google, "victim@example.test"), false);
	assert.equal(service.googleForwardingAllowed({ googleSub: "sub", googleEmail: null }, "victim@example.test"), false);
	assert.equal(service.googleForwardingAllowed({ googleSub: null, googleEmail: null }, "anyone@example.test"), true, "ordinary accounts are unaffected");
	const routes = ["src/app/api/settings/forwarding/route.ts", "src/app/api/settings/profile/route.ts"].map((file) => readFileSync(join(root, file), "utf8"));
	for (const source of routes) assert.match(source, /googleForwardingAllowed\(user,/);
});

test("the forwarding status is cached for a minute and every change drops the entry", async (t) => {
	const f = await signupFixture(t);
	const created = await service.registerGoogleMailbox(f.env, f.host, newIdentity, input);
	const user = { id: created.userId, email: "fresh@example.com", googleEmail: "fresh@gmail.com" };
	forwarding.clearForwardingStatusCache();
	const lookups = () => f.cf.calls.filter((call) => call.method === "GET" && call.path.endsWith("/addresses")).length;
	const t0 = 1_900_000_000_000;
	assert.equal(await forwarding.cachedGoogleForwardingStatus(f.env, user.email, user.googleEmail, t0), "missing");
	assert.equal(await forwarding.cachedGoogleForwardingStatus(f.env, user.email, user.googleEmail, t0 + 59_000), "missing");
	assert.equal(lookups(), 1, "a second read inside 60s does not call Cloudflare");
	await forwarding.cachedGoogleForwardingStatus(f.env, user.email, user.googleEmail, t0 + forwarding.FORWARDING_STATUS_TTL_MS + 1);
	assert.equal(lookups(), 2, "expired after 60s");
	assert.equal(forwarding.FORWARDING_STATUS_TTL_MS, 60_000);
	await forwarding.setGoogleForwarding(f.env, user, true);
	const before = lookups();
	assert.equal(await forwarding.cachedGoogleForwardingStatus(f.env, user.email, user.googleEmail, Date.now()), "pending", "a change is visible immediately");
	assert.ok(lookups() > before);
});

test("forwarding settings have a per-user limit: reads fail open, the toggle fails closed", async () => {
	const { allowGoogleForwardingAttempt } = await load("rate");
	const keys = [];
	const limiter = { LOGIN_RATE_LIMIT: { limit: async ({ key }) => { keys.push(key); return { success: keys.length < 3 }; } } };
	assert.equal(await allowGoogleForwardingAttempt(limiter, "usr_1"), true);
	assert.equal(await allowGoogleForwardingAttempt(limiter, "usr_2"), true);
	assert.equal(await allowGoogleForwardingAttempt(limiter, "usr_1"), false);
	assert.deepEqual(keys, ["google-forwarding:usr_1", "google-forwarding:usr_2", "google-forwarding:usr_1"], "keyed per user");
	assert.equal(await allowGoogleForwardingAttempt({}, "usr_1"), true);
	assert.equal(await allowGoogleForwardingAttempt({}, "usr_1", { failClosed: true }), false);
	const broken = { LOGIN_RATE_LIMIT: { limit: async () => { throw new Error("down"); } } };
	assert.equal(await allowGoogleForwardingAttempt(broken, "usr_1", { failClosed: true }), false);
	const source = readFileSync(join(root, "src/app/api/settings/google-forwarding/route.ts"), "utf8");
	assert.match(source, /allowGoogleForwardingAttempt\(env, user\.id\)/);
	assert.match(source, /allowGoogleForwardingAttempt\(env, user\.id, \{ failClosed: true \}\)/);
});

test("the complete route rejects a missing Sec-Fetch-Site and Origin, and checks the Google identity before Turnstile", () => {
	const post = (headers) => new Request("https://mail.example.com/api/auth/google/complete", { method: "POST", headers });
	assert.equal(hasValidSessionMutationOrigin(post({})), false, "no Sec-Fetch-Site and no Origin");
	assert.equal(hasValidSessionMutationOrigin(post({ "Sec-Fetch-Site": "cross-site" })), false);
	assert.equal(hasValidSessionMutationOrigin(post({ "Sec-Fetch-Site": "same-origin" })), true);
	assert.equal(hasValidSessionMutationOrigin(post({ Origin: "https://mail.example.com" })), true);
	assert.equal(hasValidSessionMutationOrigin(post({ Origin: "https://evil.example" })), false);
	const source = readFileSync(join(root, "src/app/api/auth/google/complete/route.ts"), "utf8");
	assert.match(source, /!hasValidSessionMutationOrigin\(request\)/);
	assert.ok(source.indexOf("await findIdentity(") < source.indexOf("await verifyTurnstileToken("), "identity first, Turnstile second");
});
