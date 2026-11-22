import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, users } from "@/db/schema";
import { cfRequest } from "@/lib/cloudflare-api";

type Destination = { email?: string; verified?: string | null };

export type ForwardingStatus = "off" | "missing" | "pending" | "verified" | "error";

const PAGE_SIZE = 50;
const MAX_PAGES = 20;

/**
 * Account that owns the Email Routing destination addresses: CF_ACCOUNT_ID when set, otherwise the account
 * of the zone the user's own mailbox domain lives in (the same fallback the forwarding verification uses).
 */
async function resolveAccountId(env: CloudflareEnv, userEmail: string): Promise<string> {
	const configured = env.CF_ACCOUNT_ID?.trim();
	if (configured) {
		if (!/^[a-f0-9]{32}$/.test(configured)) throw new Error("Forwarding account is not configured");
		return configured;
	}
	const hostname = userEmail.split("@")[1]?.toLowerCase();
	const [domain] = hostname ? await getDb(env).select({ zoneId: domains.zoneId }).from(domains).where(eq(domains.hostname, hostname)).limit(1) : [];
	if (!domain) throw new Error("Forwarding account is not configured");
	const zone = await cfRequest<{ account?: { id?: string } }>(env, `/zones/${domain.zoneId}`);
	if (!zone.account?.id) throw new Error("Forwarding account is not configured");
	return zone.account.id;
}

/** Only ever looks up the one address it is given; the destination list is never returned. */
export async function googleForwardingStatus(env: CloudflareEnv, userEmail: string, googleEmail: string): Promise<"missing" | "pending" | "verified"> {
	const accountId = await resolveAccountId(env, userEmail);
	const wanted = googleEmail.toLowerCase();
	for (let page = 1; page <= MAX_PAGES; page++) {
		const rows = await cfRequest<Destination[]>(env, `/accounts/${accountId}/email/routing/addresses?page=${page}&per_page=${PAGE_SIZE}`);
		const destination = rows.find((row) => row.email?.toLowerCase() === wanted);
		if (destination) return destination.verified ? "verified" : "pending";
		if (rows.length < PAGE_SIZE) return "missing";
	}
	throw new Error("Could not check forwarding address");
}

export const FORWARDING_STATUS_TTL_MS = 60_000;
const MAX_CACHED = 500;
const statusCache = new Map<string, { status: "missing" | "pending" | "verified"; expiresAt: number }>();

/**
 * Status for the settings card, remembered for a minute per Google address so reloads and the Check status button
 * cannot make the worker walk Cloudflare's destination list over and over. Per isolate and best effort: nothing in
 * the app needs the answer to be shared, and every change through setGoogleForwarding drops the entry.
 */
export async function cachedGoogleForwardingStatus(env: CloudflareEnv, userEmail: string, googleEmail: string, now = Date.now()): Promise<"missing" | "pending" | "verified"> {
	const key = googleEmail.toLowerCase();
	const hit = statusCache.get(key);
	if (hit && hit.expiresAt > now) return hit.status;
	const status = await googleForwardingStatus(env, userEmail, googleEmail);
	if (statusCache.size >= MAX_CACHED) statusCache.clear();
	statusCache.set(key, { status, expiresAt: now + FORWARDING_STATUS_TTL_MS });
	return status;
}

export function clearForwardingStatusCache(googleEmail?: string): void {
	if (googleEmail) statusCache.delete(googleEmail.toLowerCase());
	else statusCache.clear();
}

/** Registers the Google email as an Email Routing destination (Cloudflare sends its own verification mail). */
export async function requestGoogleForwarding(env: CloudflareEnv, userEmail: string, googleEmail: string): Promise<"pending" | "verified"> {
	const status = await googleForwardingStatus(env, userEmail, googleEmail);
	if (status !== "missing") return status;
	const accountId = await resolveAccountId(env, userEmail);
	const result = await cfRequest<Destination>(env, `/accounts/${accountId}/email/routing/addresses`, {
		method: "POST",
		body: JSON.stringify({ email: googleEmail }),
	});
	return result.verified ? "verified" : "pending";
}

/**
 * Turns forwarding on or off for one user. The destination is always the user's stored Google-verified email,
 * never anything the client sent. When Cloudflare fails the setting is left untouched and "error" is returned.
 */
export async function setGoogleForwarding(
	env: CloudflareEnv,
	user: { id: string; email: string; googleEmail: string },
	enabled: boolean,
): Promise<ForwardingStatus> {
	const db = getDb(env);
	clearForwardingStatusCache(user.googleEmail);
	if (!enabled) {
		await db.update(users).set({ forwardingEmail: null }).where(eq(users.id, user.id));
		return "off";
	}
	try {
		const status = await requestGoogleForwarding(env, user.email, user.googleEmail);
		await db.update(users).set({ forwardingEmail: user.googleEmail }).where(eq(users.id, user.id));
		return status;
	} catch (error) {
		console.error("Google forwarding setup failed", error);
		return "error";
	}
}
