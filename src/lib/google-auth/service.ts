import { and, count, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, users } from "@/db/schema";
import { createAccountResponse } from "@/app/api/accounts/create";
import { GOOGLE_ONLY_PASSWORD_HASH, PASSWORDLESS_PASSWORD_HASH } from "@/lib/auth/password";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { countUsedAccountSeats } from "@/lib/licenses/seats";
import type { GoogleAuthHost } from "./config";
import type { GoogleIdentity } from "./flows";
import { setGoogleForwarding, type ForwardingStatus } from "./forwarding";
import { validateSignupLocalPart } from "./reserved";

export type ServiceResult<T extends object = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };

/** Accounts that self-signed up with Google may not exceed this. */
export const GOOGLE_SIGNUP_ACCOUNT_CAP = 50;
/** Seats self sign-up never takes, so an admin can still create accounts. */
export const GOOGLE_SIGNUP_RESERVED_SEATS = 2;
const UNAVAILABLE = "Sign-up is currently unavailable.";
const ALREADY_REGISTERED = "This Google account already has a mailbox. Log in instead.";

export async function findUserByGoogleSub(env: CloudflareEnv, sub: string) {
	const [user] = await getDb(env).select().from(users).where(eq(users.googleSub, sub)).limit(1);
	return user ?? null;
}

/** Self-service capacity: the Google-account cap and the seats kept free for admins. Never explains why to the caller. */
async function signupHasCapacity(env: CloudflareEnv): Promise<boolean> {
	const [row] = await getDb(env).select({ total: count() }).from(users).where(and(isNotNull(users.googleSub), isNull(users.deletedAt)));
	if ((row?.total ?? 0) >= GOOGLE_SIGNUP_ACCOUNT_CAP) return false;
	const { accountSeatLimit } = await getLicenseEntitlements(env);
	if (accountSeatLimit === null) return true;
	return (await countUsedAccountSeats(env)) + GOOGLE_SIGNUP_RESERVED_SEATS < accountSeatLimit;
}

/**
 * Creates a Google-only mailbox (no password) through the same code path as admin account creation, then
 * optionally registers the Google email for forwarding. Forwarding failure never fails the sign-up.
 */
export async function registerGoogleMailbox(
	env: CloudflareEnv,
	host: GoogleAuthHost,
	identity: GoogleIdentity,
	input: { username: unknown; forwardToGmail?: boolean },
): Promise<ServiceResult<{ userId: string; forwarding: ForwardingStatus }>> {
	const local = validateSignupLocalPart(input.username);
	if (!local.ok) return { ok: false, status: 400, error: local.error };
	const holder = await findUserByGoogleSub(env, identity.googleSub);
	if (holder && !holder.deletedAt) return { ok: false, status: 409, error: ALREADY_REGISTERED };
	if (!(await signupHasCapacity(env))) return { ok: false, status: 503, error: UNAVAILABLE };

	const db = getDb(env);
	const [domain] = await db.select().from(domains).where(eq(domains.hostname, host.domain)).limit(1);
	const [owner] = domain ? await db.select().from(users).where(eq(users.id, domain.userId)).limit(1) : [];
	if (!domain || !owner || domain.status !== "active") {
		return { ok: false, status: 503, error: "Sign-up is not available right now." };
	}

	// A soft-deleted account no longer holds the Google account; release it so the unique sub is free.
	if (holder) await db.update(users).set({ googleSub: null }).where(eq(users.id, holder.id));
	const response = await createAccountResponse(
		env,
		{ id: owner.id, canManageMailboxes: owner.canManageMailboxes, createdByUserId: owner.createdByUserId },
		{ username: local.value, domainId: domain.id, password: "", role: "user", useAllDomains: false, aliases: [] },
		{ resetEmail: identity.email, googleSub: identity.googleSub, googleEmail: identity.email, name: identity.name ?? undefined, passwordHash: GOOGLE_ONLY_PASSWORD_HASH },
	);
	const body = (await response.json().catch(() => null)) as { account?: { id?: string }; error?: unknown } | null;
	if (response.status === 201 && body?.account?.id) {
		const userId = body.account.id;
		const forwarding = input.forwardToGmail
			? await setGoogleForwarding(env, { id: userId, email: `${local.value}@${host.domain}`, googleEmail: identity.email }, true)
			: "off";
		return { ok: true, userId, forwarding };
	}
	// A concurrent sign-up with the same Google account loses on the unique index.
	const winner = await findUserByGoogleSub(env, identity.googleSub);
	if (winner && !winner.deletedAt) return { ok: false, status: 409, error: ALREADY_REGISTERED };
	// Seat, permission and domain errors describe the instance; anonymous users get a generic answer.
	if (response.status === 403 || response.status === 404) return { ok: false, status: 503, error: UNAVAILABLE };
	if (response.status === 409) return { ok: false, status: 409, error: "That UserID is taken. Pick another one." };
	return { ok: false, status: response.status >= 500 ? 502 : response.status, error: typeof body?.error === "string" ? body.error : "Could not create the mailbox. Try again." };
}

export type GoogleLoginBlock = "disabled" | "passkey" | "mfa";

/**
 * Why "Continue with Google" must not log this linked account in, or null when it may. Google proves one
 * factor, so accounts that rely on a passkey or require a second factor use their normal login. Refusing here,
 * rather than clearing google_sub on every path that makes an account passkey-only, keeps the link (and the
 * one-mailbox-per-Google-account rule) intact and covers any future way of becoming passkey-only.
 */
export function googleLoginBlock(user: { disabled: boolean; passwordHash: string; requireSecondFactor: boolean; totpEnabled: boolean }): GoogleLoginBlock | null {
	if (user.disabled) return "disabled";
	if (user.passwordHash === PASSWORDLESS_PASSWORD_HASH) return "passkey";
	if (user.requireSecondFactor || user.totpEnabled) return "mfa";
	return null;
}

/**
 * Forwarding for a Google-created account may only be off or its Google-verified email: the older forwarding
 * settings must not let it point at an arbitrary address (or at an unverified destination in the shared list).
 */
export function googleForwardingAllowed(user: { googleSub: string | null; googleEmail: string | null }, value: string | null | undefined): boolean {
	if (!user.googleSub || !value) return true;
	return !!user.googleEmail && value.trim().toLowerCase() === user.googleEmail.toLowerCase();
}
