/** Local parts a self-service sign-up may never claim; they belong to the operator. */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
	"abuse", "fmail", "mailflare", "admin", "administrator", "billing", "contact", "dmarc", "ftp", "help",
	"hostmaster", "info", "mail", "mailer-daemon", "marketing", "news", "no-reply", "nobody", "noc", "noreply",
	"postmaster", "privacy", "root", "sales", "security", "support", "system", "usenet", "uucp", "webmaster",
	"www",
]);

/** fmail's UserID rules: 1-32 letters, numbers, underscores or hyphens, starting with a letter or number. */
const LOCAL_PART = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const INVALID_USERID_MESSAGE = "Choose a valid UserID: 1-32 characters, starting with a letter or number. Use letters, numbers, _ or -";

export type LocalPartResult = { ok: true; value: string } | { ok: false; error: string };

/** Lower-cases and validates the UserID a user picked. */
export function validateSignupLocalPart(input: unknown): LocalPartResult {
	const value = typeof input === "string" ? input.trim().toLowerCase() : "";
	if (!LOCAL_PART.test(value)) return { ok: false, error: INVALID_USERID_MESSAGE };
	if (RESERVED_LOCAL_PARTS.has(value)) return { ok: false, error: "That UserID is reserved. Pick another one." };
	return { ok: true, value };
}
