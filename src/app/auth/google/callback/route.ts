import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import { getRequestHost } from "@/lib/branding/request-host";
import { allowGoogleAuthAttempt } from "@/lib/auth/rate-limit";
import { ACCOUNTS_COOKIE, rememberLogin } from "@/lib/auth/accounts";
import { recordAuthActivity } from "@/lib/auth/activity";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { resolveGoogleAuth } from "@/lib/google-auth/config";
import { exchangeCode, OAuthFailure, verifyIdToken } from "@/lib/google-auth/oidc";
import { clearFlowCookie, consumeOauthFlow, createIdentity, flowCookie, IDENTITY_COOKIE, IDENTITY_TTL_MS, OAUTH_COOKIE, readCookie } from "@/lib/google-auth/flows";
import { findUserByGoogleSub, googleLoginBlock } from "@/lib/google-auth/service";

const encoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
	const x = encoder.encode(a);
	const y = encoder.encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

function redirect(request: Request, path: string, cookies: string[]): NextResponse {
	const response = NextResponse.redirect(new URL(path, request.url), 302);
	for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
	response.headers.set("Cache-Control", "no-store");
	return response;
}

/**
 * Google redirects here after consent. A Google account that already owns a mailbox is logged in; a new one
 * continues to the UserID step. Every failure bounces back to the page that started the flow with a short
 * error code; the user never sees a raw error.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const config = resolveGoogleAuth(env, await getRequestHost());
	if (!config) return new NextResponse("Not found", { status: 404 });
	if (!(await allowGoogleAuthAttempt(env, request))) {
		return new NextResponse("Too many attempts. Try again shortly.", { status: 429, headers: { "Retry-After": "60" } });
	}

	const params = new URL(request.url).searchParams;
	const cookieToken = readCookie(request, OAUTH_COOKIE);
	// Consume the request first so it can never be replayed, even on failure.
	const flow = cookieToken ? await consumeOauthFlow(env, cookieToken) : null;
	const clear = [clearFlowCookie(OAUTH_COOKIE)];
	const back = (code: string) => redirect(request, `${flow?.purpose === "signup" ? "/signup" : "/login"}?error=${code}`, clear);

	if (params.get("error")) return back("cancelled");
	if (!flow || flow.host !== config.host) return back("expired");
	const code = params.get("code") ?? "";
	if (!code || !timingSafeEqual(params.get("state") ?? "", flow.state)) return back("state");

	let identity;
	try {
		identity = await verifyIdToken(await exchangeCode(config, code, flow.codeVerifier), config.clientId, flow.nonce);
	} catch (error) {
		if (error instanceof OAuthFailure) {
			console.error("Google sign-in rejected", error.code);
			return back(error.code);
		}
		console.error("Google sign-in error", error);
		return back("token");
	}

	const linked = await findUserByGoogleSub(env, identity.sub);
	if (linked && !linked.deletedAt) {
		const block = googleLoginBlock(linked);
		if (block) return redirect(request, `/login?error=${block}`, clear);
		const token = await createSession(env, linked.id);
		await recordAuthActivity(env, { action: "auth.login", userId: linked.id, request });
		const response = redirect(request, "/inbox", clear);
		response.cookies.set(SESSION_COOKIE, token, {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax",
			path: "/",
			maxAge: 60 * 60 * 24 * 30,
		});
		const jar = await cookies();
		await rememberLogin(env, response, jar.get(ACCOUNTS_COOKIE)?.value, token, jar.get(SESSION_COOKIE)?.value);
		return response;
	}

	const token = await createIdentity(env, { purpose: flow.purpose, host: config.host, googleSub: identity.sub, email: identity.email, name: identity.name });
	return redirect(request, "/signup?step=username", [...clear, flowCookie(IDENTITY_COOKIE, token, Math.floor(IDENTITY_TTL_MS / 1000))]);
}
