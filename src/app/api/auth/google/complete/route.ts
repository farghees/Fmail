import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getRequestHost } from "@/lib/branding/request-host";
import { allowGoogleAuthAttempt } from "@/lib/auth/rate-limit";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { completeLogin } from "@/lib/auth/login-response";
import { verifyTurnstileToken } from "@/lib/auth/turnstile";
import { readJsonBody } from "@/lib/http/request";
import { resolveGoogleAuth } from "@/lib/google-auth/config";
import { clearFlowCookie, deleteIdentity, findIdentity, IDENTITY_COOKIE, readCookie } from "@/lib/google-auth/flows";
import { registerGoogleMailbox } from "@/lib/google-auth/service";

const noStore = { "Cache-Control": "no-store" };
const failure = (status: number, error: string, extra: Record<string, unknown> = {}) =>
	NextResponse.json({ error, ...extra }, { status, headers: noStore });

/**
 * Submits the UserID step. The Google identity comes only from the server-side row the callback wrote
 * (looked up through the HttpOnly cookie); the body never carries an email or sub.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const host = resolveGoogleAuth(env, await getRequestHost());
	if (!host) return new NextResponse("Not found", { status: 404 });
	// This creates accounts, so it refuses when the limiter is missing or broken.
	if (!(await allowGoogleAuthAttempt(env, request, { failClosed: true }))) {
		return NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429, headers: { ...noStore, "Retry-After": "60" } });
	}
	// Cookie-authenticated mutation: same rule as the session routes, so a missing Sec-Fetch-Site and Origin is refused too.
	if (!hasValidSessionMutationOrigin(request)) return failure(403, "Request blocked.");

	let body: Record<string, unknown>;
	try {
		const parsed = await readJsonBody(request, 16 * 1024);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failure(400, "Invalid sign-up request");
		body = parsed as Record<string, unknown>;
	} catch {
		return failure(400, "Invalid sign-up request");
	}
	// Look the identity up first so a request without a valid Google sign-in never spends a Turnstile check.
	const identity = await findIdentity(env, readCookie(request, IDENTITY_COOKIE), host.host);
	if (!identity) return failure(401, "Your Google sign-in expired. Start again.", { code: "expired" });
	// Active only when the Turnstile secret is set; verifyTurnstileToken accepts everything otherwise.
	if (!(await verifyTurnstileToken(env, request, body.turnstileToken))) return failure(400, "Verification failed. Please try again.");

	const forwardToGmail = body.forwardToGmail === true;
	const created = await registerGoogleMailbox(env, host, identity, { username: body.username, forwardToGmail });
	if (!created.ok) return failure(created.status, created.error);
	await deleteIdentity(env, identity.id);

	// Straight to the inbox, or to the settings page that shows the forwarding state when it was ticked.
	const redirect = !forwardToGmail ? "/inbox" : created.forwarding === "error" ? "/settings/account?googleForwarding=error" : "/settings/account";
	const response = await completeLogin(env, request, created.userId, { body: { redirect, forwardingStatus: created.forwarding } });
	response.headers.append("Set-Cookie", clearFlowCookie(IDENTITY_COOKIE));
	return response;
}
