import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getRequestHost } from "@/lib/branding/request-host";
import { allowGoogleAuthAttempt } from "@/lib/auth/rate-limit";
import { resolveGoogleAuth } from "@/lib/google-auth/config";
import { buildAuthUrl, pkceChallenge } from "@/lib/google-auth/oidc";
import { createOauthFlow, flowCookie, isGooglePurpose, OAUTH_COOKIE, OAUTH_TTL_MS, randomToken } from "@/lib/google-auth/flows";

const notFound = () => new NextResponse("Not found", { status: 404 });

/** Starts "Continue with Google" for sign-up or login. Top-level navigation, so it is a GET redirect. */
export async function GET(request: Request) {
	const env = getEnv();
	const config = resolveGoogleAuth(env, await getRequestHost());
	if (!config) return notFound();
	if (!(await allowGoogleAuthAttempt(env, request))) {
		return new NextResponse("Too many attempts. Try again shortly.", { status: 429, headers: { "Retry-After": "60" } });
	}
	// Linked accounts are logged in and new ones continue to the UserID step, whichever page the button was on.
	const requested = new URL(request.url).searchParams.get("purpose");
	const purpose = isGooglePurpose(requested) ? requested : "login";

	const state = randomToken(32);
	const codeVerifier = randomToken(48);
	const nonce = randomToken(32);
	const token = await createOauthFlow(env, { purpose, host: config.host, state, codeVerifier, nonce });
	const response = NextResponse.redirect(buildAuthUrl(config, state, nonce, await pkceChallenge(codeVerifier)), 302);
	response.headers.append("Set-Cookie", flowCookie(OAUTH_COOKIE, token, Math.floor(OAUTH_TTL_MS / 1000)));
	response.headers.set("Cache-Control", "no-store");
	return response;
}
