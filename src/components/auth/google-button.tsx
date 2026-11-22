"use client";

import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import type { TranslationKey } from "@/lib/i18n/types";

const ERROR_CODES = ["disabled", "passkey", "mfa", "cancelled", "expired", "state", "token", "signature", "claims", "nonce", "unverified"] as const;

/** Message for the short error code the Google callback puts in the query string. */
export function googleErrorKey(code: string | null | undefined): TranslationKey | null {
	if (!code) return null;
	return (ERROR_CODES as readonly string[]).includes(code) ? (`auth.google.error.${code}` as TranslationKey) : "auth.google.error.generic";
}

export function GoogleMark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
			<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
			<path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
			<path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z" />
			<path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.9 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
		</svg>
	);
}

/** Starts the Google flow with a top-level navigation; the server answers 404 where the feature is off. */
export function GoogleButton({ purpose }: { purpose: "signup" | "login" }) {
	const { t } = useLanguage();
	return (
		<Button asChild variant="outline" className="h-11 w-full rounded-full">
			<a href={`/api/auth/google/start?purpose=${purpose}`}>
				<GoogleMark className="h-4 w-4" />
				{t("auth.google.continue")}
			</a>
		</Button>
	);
}
