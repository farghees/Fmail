import { and, eq, gt, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { googleAuthFlows } from "@/db/schema";
import { hashSessionToken } from "@/lib/auth/session";

export const OAUTH_COOKIE = "__Host-mf_google_oauth";
export const IDENTITY_COOKIE = "__Host-mf_google_identity";
export const OAUTH_TTL_MS = 10 * 60 * 1000;
export const IDENTITY_TTL_MS = 15 * 60 * 1000;

/** Where the flow started: the sign-up page or the login page. Both end the same way; only failures differ. */
export type GooglePurpose = "signup" | "login";

export function isGooglePurpose(value: unknown): value is GooglePurpose {
	return value === "signup" || value === "login";
}

export function randomToken(bytes: number): string {
	const data = crypto.getRandomValues(new Uint8Array(bytes));
	let binary = "";
	for (const byte of data) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cookie for a flow step. Lax so the browser still sends it on Google's top-level redirect back. */
export function flowCookie(name: string, value: string, maxAgeSeconds: number): string {
	// __Host- cookies must be Secure, Path=/ and carry no Domain attribute.
	return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearFlowCookie(name: string): string {
	return flowCookie(name, "", 0);
}

export function readCookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) {
			try {
				return decodeURIComponent(rest.join("="));
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/** Stores the OAuth request and returns the opaque token that goes into the browser cookie. */
export async function createOauthFlow(
	env: CloudflareEnv,
	row: { purpose: GooglePurpose; host: string; state: string; codeVerifier: string; nonce: string },
	now = Date.now(),
): Promise<string> {
	const db = getDb(env);
	const token = randomToken(32);
	await db.delete(googleAuthFlows).where(lt(googleAuthFlows.expiresAt, new Date(now)));
	await db.insert(googleAuthFlows).values({
		id: await hashSessionToken(token),
		purpose: row.purpose,
		stage: "oauth",
		host: row.host,
		state: row.state,
		codeVerifier: row.codeVerifier,
		nonce: row.nonce,
		expiresAt: new Date(now + OAUTH_TTL_MS),
	});
	return token;
}

/** Single use: the row is deleted whether or not the caller goes on to accept it. */
export async function consumeOauthFlow(env: CloudflareEnv, token: string, now = Date.now()) {
	const db = getDb(env);
	const id = await hashSessionToken(token);
	const [row] = await db
		.delete(googleAuthFlows)
		.where(and(eq(googleAuthFlows.id, id), eq(googleAuthFlows.stage, "oauth")))
		.returning();
	if (!row || row.expiresAt.getTime() <= now || !row.state || !row.codeVerifier || !row.nonce) return null;
	return { purpose: row.purpose, host: row.host, state: row.state, codeVerifier: row.codeVerifier, nonce: row.nonce };
}

/** Holds the verified Google identity between the callback and the register / reset form. */
export async function createIdentity(
	env: CloudflareEnv,
	row: { purpose: GooglePurpose; host: string; googleSub: string; email: string; name: string | null },
	now = Date.now(),
): Promise<string> {
	const token = randomToken(32);
	await getDb(env).insert(googleAuthFlows).values({
		id: await hashSessionToken(token),
		purpose: row.purpose,
		stage: "identity",
		host: row.host,
		googleSub: row.googleSub,
		email: row.email,
		name: row.name,
		expiresAt: new Date(now + IDENTITY_TTL_MS),
	});
	return token;
}

export type GoogleIdentity = { id: string; googleSub: string; email: string; name: string | null };

/** The identity only if it exists, is unexpired, and was verified on this host. */
export async function findIdentity(
	env: CloudflareEnv,
	token: string | undefined,
	host: string,
	now = Date.now(),
): Promise<GoogleIdentity | null> {
	if (!token) return null;
	const id = await hashSessionToken(token);
	const [row] = await getDb(env)
		.select()
		.from(googleAuthFlows)
		.where(and(
			eq(googleAuthFlows.id, id),
			eq(googleAuthFlows.stage, "identity"),
			eq(googleAuthFlows.host, host),
			gt(googleAuthFlows.expiresAt, new Date(now)),
		))
		.limit(1);
	if (!row?.googleSub || !row.email) return null;
	return { id: row.id, googleSub: row.googleSub, email: row.email, name: row.name };
}

export async function deleteIdentity(env: CloudflareEnv, id: string): Promise<void> {
	await getDb(env).delete(googleAuthFlows).where(eq(googleAuthFlows.id, id));
}
