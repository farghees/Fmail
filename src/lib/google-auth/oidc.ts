export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const VALID_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;

export interface GoogleConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

/** Callback path registered with Google; the origin is the request host. */
export const GOOGLE_CALLBACK_PATH = "/auth/google/callback";

/** Error code shown to the user on the register or reset page. */
export class OAuthFailure extends Error {
	constructor(public readonly code: "token" | "signature" | "claims" | "nonce" | "unverified") {
		super(`Google sign-in failed: ${code}`);
		this.name = "OAuthFailure";
	}
}

export interface GoogleClaims {
	sub: string;
	email: string;
	name: string | null;
}

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new OAuthFailure("token");
	return parsed as Record<string, unknown>;
}

export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	let binary = "";
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildAuthUrl(config: GoogleConfig, state: string, nonce: string, challenge: string): string {
	const url = new URL(GOOGLE_AUTH_URL);
	url.search = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: config.redirectUri,
		response_type: "code",
		scope: "openid email profile",
		state,
		nonce,
		code_challenge: challenge,
		code_challenge_method: "S256",
		prompt: "select_account",
	}).toString();
	return url.toString();
}

export async function exchangeCode(config: GoogleConfig, code: string, verifier: string): Promise<string> {
	const res = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			code,
			client_id: config.clientId,
			client_secret: config.clientSecret,
			redirect_uri: config.redirectUri,
			grant_type: "authorization_code",
			code_verifier: verifier,
		}),
	});
	if (!res.ok) throw new OAuthFailure("token");
	const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
	if (!body || typeof body.id_token !== "string") throw new OAuthFailure("token");
	return body.id_token;
}

interface Jwk extends JsonWebKey {
	kid?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

export function clearJwksCache(): void {
	jwksCache = null;
}

async function loadJwks(forceRefresh: boolean): Promise<Jwk[]> {
	const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
	if (fresh && !forceRefresh) return jwksCache!.keys;
	const res = await fetch(GOOGLE_JWKS_URL);
	if (!res.ok) throw new OAuthFailure("signature");
	const body = (await res.json().catch(() => null)) as { keys?: unknown } | null;
	if (!body || !Array.isArray(body.keys)) throw new OAuthFailure("signature");
	jwksCache = { keys: body.keys as Jwk[], fetchedAt: Date.now() };
	return jwksCache.keys;
}

async function findVerificationKey(kid: string): Promise<CryptoKey> {
	for (const refresh of [false, true]) {
		const jwk = (await loadJwks(refresh)).find((k) => k.kid === kid);
		if (jwk) {
			return crypto.subtle.importKey(
				"jwk",
				{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
				{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
				false,
				["verify"],
			);
		}
	}
	throw new OAuthFailure("signature");
}

/** Verifies an RS256 id_token and its claims. Throws OAuthFailure with a specific code. */
export async function verifyIdToken(
	idToken: string,
	clientId: string,
	expectedNonce: string,
	now: number = Date.now(),
): Promise<GoogleClaims> {
	const parts = idToken.split(".");
	if (parts.length !== 3) throw new OAuthFailure("token");
	const [headerSeg, payloadSeg, sigSeg] = parts;
	const header = decodeJsonSegment(headerSeg);
	if (header.alg !== "RS256" || typeof header.kid !== "string") throw new OAuthFailure("signature");

	const key = await findVerificationKey(header.kid);
	const valid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		b64urlToBytes(sigSeg),
		new TextEncoder().encode(`${headerSeg}.${payloadSeg}`),
	);
	if (!valid) throw new OAuthFailure("signature");

	const claims = decodeJsonSegment(payloadSeg);
	const nowSeconds = Math.floor(now / 1000);
	if (typeof claims.iss !== "string" || !VALID_ISSUERS.has(claims.iss)) throw new OAuthFailure("claims");
	if (claims.aud !== clientId) throw new OAuthFailure("claims");
	if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) throw new OAuthFailure("claims");
	if (typeof claims.iat === "number" && claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new OAuthFailure("claims");
	if (claims.nonce !== expectedNonce) throw new OAuthFailure("nonce");
	if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new OAuthFailure("claims");
	if (typeof claims.email !== "string" || claims.email.length === 0) throw new OAuthFailure("claims");
	if (claims.email_verified !== true && claims.email_verified !== "true") throw new OAuthFailure("unverified");

	return {
		sub: claims.sub,
		email: claims.email.trim().toLowerCase(),
		name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 100) : null,
	};
}
