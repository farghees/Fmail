import { normalizeHost, resolveHostBranding, type HostBrandingEnv } from "@/lib/branding/hosts";
import { GOOGLE_CALLBACK_PATH, type GoogleConfig } from "./oidc";

export type GoogleAuthHost = GoogleConfig & {
	/** Normalised request host the flow runs on. */
	host: string;
	/** Mail domain new mailboxes are created on. */
	domain: string;
};

type GoogleEnv = HostBrandingEnv & { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string };

/**
 * Google sign-up and reset are active for a host only when the host is configured for it in
 * APP_HOST / GOOGLE_SIGNUP_DOMAIN (or HOST_BRANDING) and both Worker secrets exist; otherwise this is null and the routes answer 404.
 */
export function resolveGoogleAuth(env: GoogleEnv, host: string | null | undefined): GoogleAuthHost | null {
	const googleAuth = resolveHostBranding(host, env)?.googleAuth;
	const clientId = env.GOOGLE_CLIENT_ID?.trim();
	const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
	if (!googleAuth || !clientId || !clientSecret) return null;
	const normalized = normalizeHost(host);
	return {
		host: normalized,
		domain: googleAuth.domain.toLowerCase(),
		clientId,
		clientSecret,
		redirectUri: `https://${normalized}${GOOGLE_CALLBACK_PATH}`,
	};
}
