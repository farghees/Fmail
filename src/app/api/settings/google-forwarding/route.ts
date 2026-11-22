import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { allowGoogleForwardingAttempt } from "@/lib/auth/rate-limit";
import { cachedGoogleForwardingStatus, setGoogleForwarding, type ForwardingStatus } from "@/lib/google-auth/forwarding";

const noStore = { "Cache-Control": "no-store" };

type Current = { id: string; email: string; googleSub: string | null; googleEmail: string | null; forwardingEmail: string | null };

/** The destination is always the stored Google email; nothing the client sends can change it. */
function view(user: { googleEmail: string }, status: ForwardingStatus) {
	return { available: true, email: user.googleEmail, status };
}

export async function GET(request: Request) {
	const env = getEnv();
	const user = (await getCurrentUser(env, request)) as Current | null;
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
	if (!user.googleSub || !user.googleEmail) return NextResponse.json({ available: false }, { headers: noStore });
	if (!(await allowGoogleForwardingAttempt(env, user.id))) return NextResponse.json({ error: "Try again shortly" }, { status: 429, headers: { ...noStore, "Retry-After": "60" } });
	const googleEmail = user.googleEmail;
	if (user.forwardingEmail?.toLowerCase() !== googleEmail.toLowerCase()) return NextResponse.json(view({ googleEmail }, "off"), { headers: noStore });
	try {
		const status = await cachedGoogleForwardingStatus(env, user.email, googleEmail);
		// Not registered with Cloudflare any more: nothing can be delivered, so it is not "on".
		return NextResponse.json(view({ googleEmail }, status === "missing" ? "off" : status), { headers: noStore });
	} catch (error) {
		console.error("Google forwarding status failed", error);
		return NextResponse.json(view({ googleEmail }, "error"), { headers: noStore });
	}
}

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = (await getCurrentUser(env, request)) as Current | null;
	if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403, headers: noStore });
	if (!user.googleSub || !user.googleEmail) return NextResponse.json({ error: "Google sign-up is required" }, { status: 403, headers: noStore });
	if (!(await allowGoogleForwardingAttempt(env, user.id, { failClosed: true }))) return NextResponse.json({ error: "Try again shortly" }, { status: 429, headers: noStore });
	const body: unknown = await request.json().catch(() => null);
	if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean") {
		return NextResponse.json({ error: "Choose on or off" }, { status: 400, headers: noStore });
	}
	const status = await setGoogleForwarding(env, { id: user.id, email: user.email, googleEmail: user.googleEmail }, body.enabled);
	if (status === "error") return NextResponse.json({ error: "Forwarding setup could not be completed. Your mailbox is unchanged.", ...view({ googleEmail: user.googleEmail }, "error") }, { status: 502, headers: noStore });
	return NextResponse.json(view({ googleEmail: user.googleEmail }, status), { headers: noStore });
}
