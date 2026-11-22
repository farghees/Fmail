"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Mail } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { AuthShell } from "@/components/auth/auth-shell";
import { GoogleButton, googleErrorKey } from "@/components/auth/google-button";
import { TurnstileField } from "@/components/auth/turnstile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { submitGoogleForm } from "../google-form";

/** First screen (`email` null): Continue with Google. After Google (`email` set): the UserID step. */
export function SignupClient({ domain, email, errorCode }: { domain: string; email: string | null; errorCode: string | null }) {
	const { t } = useLanguage();
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [forwardToGmail, setForwardToGmail] = useState(false);
	const [turnstileReset, setTurnstileReset] = useState(0);
	const errorKey = googleErrorKey(errorCode);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setLoading(true);
		setError(null);
		try {
			const result = await submitGoogleForm({
				username: String(form.get("username") ?? ""),
				forwardToGmail,
				turnstileToken: String(form.get("turnstileToken") ?? ""),
			});
			if (result.ok) {
				router.replace(result.redirect ?? "/inbox");
				router.refresh();
				return;
			}
			if (result.code === "expired") {
				router.replace("/signup?error=expired");
				return;
			}
			setError(result.error ?? t("auth.signup.failed"));
			setTurnstileReset((value) => value + 1);
		} catch {
			setError(t("auth.signup.failed"));
			setTurnstileReset((value) => value + 1);
		} finally {
			setLoading(false);
		}
	}

	return (
		<AuthShell
			icon={Mail}
			title={t("auth.signup.title")}
			description={t("auth.signup.description")}
			footer={
				<p className="text-sm text-neutral-500">
					{t("auth.signup.haveMailbox")}{" "}
					<Link href="/login" className="text-blue-600 hover:underline">
						{t("auth.signup.logIn")}
					</Link>
				</p>
			}
		>
			{email === null ? (
				<div className="space-y-5">
					<p className="text-sm text-neutral-600">{t("auth.signup.intro", { domain })}</p>
					{errorKey && (
						<p role="alert" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{t(errorKey)}</p>
					)}
					<GoogleButton purpose="signup" />
				</div>
			) : (
				<form onSubmit={onSubmit} className="space-y-5">
					<p className="text-sm text-neutral-600">{t("auth.signup.googleAccount", { email })}</p>
					<div className="space-y-2">
						<Label htmlFor="username">{t("auth.signup.userId")}</Label>
						<div className="flex items-center gap-2">
							<Input id="username" name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" placeholder={t("auth.signup.placeholder")} required autoFocus className="flex-1" />
							<span className="shrink-0 text-sm text-neutral-500">@{domain}</span>
						</div>
					</div>
					<label className="flex items-start gap-2 text-sm text-neutral-700">
						<input type="checkbox" className="mt-1" checked={forwardToGmail} onChange={(event) => setForwardToGmail(event.target.checked)} />
						<span>{t("auth.signup.forward", { email })}</span>
					</label>
					<TurnstileField resetSignal={turnstileReset} />
					{error && (
						<p role="alert" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</p>
					)}
					<Button type="submit" className="h-11 w-full rounded-full px-6 active:scale-[0.98]" disabled={loading}>
						{loading ? t("auth.signup.creating") : t("auth.signup.submit")}
					</Button>
				</form>
			)}
		</AuthShell>
	);
}
