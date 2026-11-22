/**
 * Per-hostname branding for webmail hosts served by the same worker.
 *
 * Nothing is hardcoded: the installer sets Worker variables in wrangler.jsonc.
 *
 *   APP_HOST              Webmail host, e.g. mail.example.com. Branding and Google sign-up apply only here.
 *   APP_NAME              Product name shown on that host. Defaults to DEFAULT_APP_NAME.
 *   GOOGLE_SIGNUP_DOMAIN  Mail domain new Google sign-ups get mailboxes on, e.g. example.com.
 *                         Leave unset to keep Google sign-up off.
 *   HOST_BRANDING         Optional extra hosts (JSON object or JSON string) for serving several branded hosts:
 *                         {"mail.other.com":{"appName":"Other","googleSignupDomain":"other.com"}}
 *
 * Any host that is not configured gets the default branding and no Google sign-up.
 */
export const DEFAULT_APP_NAME = "fmail";

/** "Continue with Google" sign-up and password reset; `domain` is the mail domain new mailboxes are created on. */
export type HostGoogleAuth = { domain: string };

export type HostBranding = { appName: string; googleAuth?: HostGoogleAuth };

export type HostBrandingEnv = {
	APP_HOST?: string;
	APP_NAME?: string;
	GOOGLE_SIGNUP_DOMAIN?: string;
	HOST_BRANDING?: unknown;
};

/** Lowercases and strips port / trailing dot; takes the first value of a comma-separated forwarded header. */
export function normalizeHost(host: string | null | undefined): string {
	return (host ?? "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function extraHosts(raw: unknown): Record<string, unknown> {
	let value = raw;
	if (typeof value === "string") {
		if (!value.trim()) return {};
		try {
			value = JSON.parse(value);
		} catch {
			return {};
		}
	}
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The host to branding map described by the Worker variables. Cheap enough to build per call. */
export function getHostBranding(env: HostBrandingEnv | null | undefined): Readonly<Record<string, HostBranding>> {
	const map: Record<string, HostBranding> = Object.create(null);
	if (!env) return map;

	for (const [rawHost, rawEntry] of Object.entries(extraHosts(env.HOST_BRANDING))) {
		const host = normalizeHost(rawHost);
		const entry = rawEntry && typeof rawEntry === "object" ? (rawEntry as Record<string, unknown>) : {};
		const domain = text(entry.googleSignupDomain).toLowerCase();
		if (host) map[host] = { appName: text(entry.appName) || DEFAULT_APP_NAME, ...(domain ? { googleAuth: { domain } } : {}) };
	}

	const appHost = normalizeHost(text(env.APP_HOST));
	if (appHost) {
		const domain = text(env.GOOGLE_SIGNUP_DOMAIN).toLowerCase();
		map[appHost] = { appName: text(env.APP_NAME) || DEFAULT_APP_NAME, ...(domain ? { googleAuth: { domain } } : {}) };
	}
	return map;
}

export function resolveHostBranding(host: string | null | undefined, env: HostBrandingEnv | null | undefined): HostBranding | undefined {
	const key = normalizeHost(host);
	const map = getHostBranding(env);
	return key in map ? map[key] : undefined;
}

export function resolveAppName(host: string | null | undefined, env: HostBrandingEnv | null | undefined): string {
	return resolveHostBranding(host, env)?.appName ?? DEFAULT_APP_NAME;
}

const DEFAULT_NAME_PATTERN = new RegExp(DEFAULT_APP_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

/** Swaps the default product name in copy (translations, etc.) for the host's app name. */
export function applyBrandName(text: string, appName: string): string {
	return appName === DEFAULT_APP_NAME ? text : text.replace(DEFAULT_NAME_PATTERN, () => appName);
}

export function brandMessages<T extends Record<string, string>>(messages: T, appName: string): T {
	if (appName === DEFAULT_APP_NAME) return messages;
	return Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, applyBrandName(value, appName)])) as T;
}
