export type GoogleFormResult = { ok: boolean; redirect?: string; error?: string; code?: string };

/** Posts the register / reset form; the Google identity travels in an HttpOnly cookie, never in the body. */
export async function submitGoogleForm(body: Record<string, unknown>): Promise<GoogleFormResult> {
	const res = await fetch("/api/auth/google/complete", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(30_000),
		body: JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as { redirect?: string; error?: unknown; code?: unknown };
	return {
		ok: res.ok,
		redirect: typeof data.redirect === "string" ? data.redirect : undefined,
		error: typeof data.error === "string" ? data.error : undefined,
		code: typeof data.code === "string" ? data.code : undefined,
	};
}
