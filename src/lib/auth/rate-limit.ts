import { getClientIp } from "./client-ip";

/**
 * Key rate limits by the resolved client IP. Without a per-client key every
 * visitor lands in one shared "unknown" bucket and scanners can lock out
 * legitimate logins; trusting raw forwarding headers here would be worse —
 * a client could rotate them to leave the bucket entirely.
 */
function clientRateLimitKey(request: Request): string {
	return getClientIp(request) ?? "unknown";
}

/** Mobile sign-ins have their own, stricter budget (they skip Turnstile). */
export async function allowDeviceLoginAttempt(env: CloudflareEnv, request: Request): Promise<boolean> {
	const limiter = env.DEVICE_LOGIN_RATE_LIMIT ?? env.LOGIN_RATE_LIMIT;
	if (!limiter) return true;
	try {
		return (await limiter.limit({ key: `device:${clientRateLimitKey(request)}` })).success;
	} catch (error) {
		console.warn("Device login rate limiter unavailable", error);
		return true;
	}
}

/** Public booking submissions send mail from the host's address, so they get a per-client budget of their own. */
export async function allowBookingAttempt(env: CloudflareEnv, request: Request): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `booking:${clientRateLimitKey(request)}` })).success;
	} catch (error) {
		console.warn("Booking rate limiter unavailable", error);
		return true;
	}
}

export async function allowLoginAttempt(env: CloudflareEnv, request: Request): Promise<boolean> {
	if (!env.LOGIN_RATE_LIMIT) return true;
	try {
		const outcome = await env.LOGIN_RATE_LIMIT.limit({ key: clientRateLimitKey(request) });
		return outcome.success;
	} catch (error) {
		console.warn("Login rate limiter unavailable", error);
		return true;
	}
}

/**
 * Google sign-up and reset calls share one per-client budget. `failClosed` (the account-creating
 * submit) refuses when the limiter is unbound or errors; start and callback fail open like login.
 */
export async function allowGoogleAuthAttempt(env: CloudflareEnv, request: Request, options: { failClosed?: boolean } = {}): Promise<boolean> {
	const fallback = !options.failClosed;
	if (!env.LOGIN_RATE_LIMIT) return fallback;
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `google:${clientRateLimitKey(request)}` })).success;
	} catch (error) {
		console.warn("Google auth rate limiter unavailable", error);
		return fallback;
	}
}

/** Per-user budget for the Google forwarding settings (reads hit the Cloudflare API, writes change an account-wide list). */
export async function allowGoogleForwardingAttempt(env: CloudflareEnv, userId: string, options: { failClosed?: boolean } = {}): Promise<boolean> {
	const fallback = !options.failClosed;
	if (!env.LOGIN_RATE_LIMIT) return fallback;
	try {
		return (await env.LOGIN_RATE_LIMIT.limit({ key: `google-forwarding:${userId}` })).success;
	} catch (error) {
		console.warn("Google forwarding rate limiter unavailable", error);
		return fallback;
	}
}
