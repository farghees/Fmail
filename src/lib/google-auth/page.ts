import { cookies, headers } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import { getRequestHost } from "@/lib/branding/request-host";
import { resolveGoogleAuth, type GoogleAuthHost } from "./config";
import { findIdentity, IDENTITY_COOKIE } from "./flows";

/** Server pages: the Google config for the current host, or null when the feature is off here. */
export async function getGoogleAuthForPage(): Promise<GoogleAuthHost | null> {
	void (await headers());
	return resolveGoogleAuth(getEnv(), await getRequestHost());
}

/** Server pages: the verified Google identity behind the form, or null when there is none. */
export async function getGoogleIdentityForPage() {
	const config = await getGoogleAuthForPage();
	if (!config) return null;
	const token = (await cookies()).get(IDENTITY_COOKIE)?.value;
	const identity = await findIdentity(getEnv(), token, config.host);
	return identity ? { config, identity } : null;
}
