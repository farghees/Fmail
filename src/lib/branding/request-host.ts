import { headers } from "next/headers";
import { isNodeRuntime } from "@/lib/runtime";

/**
 * The host a request was addressed to. `x-forwarded-host` is client-controllable unless a trusted proxy
 * overwrites it, so it is honoured only on the self-hosted Node runtime (which sits behind one). On Workers
 * the `host` header is set by Cloudflare and is the only source.
 */
export function pickRequestHost(h: Pick<Headers, "get">, trustForwardedHost: boolean): string | null {
	return (trustForwardedHost ? h.get("x-forwarded-host") : null) ?? h.get("host");
}

/** Host the current request was addressed to, or null outside a request (cron, queues, tests). */
export async function getRequestHost(): Promise<string | null> {
	try {
		return pickRequestHost(await headers(), isNodeRuntime());
	} catch {
		return null;
	}
}
