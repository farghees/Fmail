"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import type { TranslationKey } from "@/lib/i18n/types";

type State = { available: boolean; email?: string; status?: "off" | "pending" | "verified" | "error" };

const STATUS_TEXT: Record<NonNullable<State["status"]>, TranslationKey> = {
	off: "settings.googleForwarding.off",
	pending: "settings.googleForwarding.pending",
	verified: "settings.googleForwarding.verified",
	error: "settings.googleForwarding.error",
};

/** Backup address and forwarding for mailboxes created with Google; renders nothing for other accounts. */
export function GoogleForwarding() {
	const { t } = useLanguage();
	const [state, setState] = useState<State | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const refresh = useCallback(async () => {
		const response = await authFetch("/api/settings/google-forwarding");
		if (response.ok) setState((await response.json()) as State);
	}, []);

	useEffect(() => {
		if (new URLSearchParams(window.location.search).get("googleForwarding") === "error") setError(t("settings.googleForwarding.setupFailed"));
		void refresh().catch(() => undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refresh]);

	if (!state?.available) return null;
	const status = state.status ?? "off";
	const enabled = status === "pending" || status === "verified";

	async function toggle() {
		setBusy(true);
		setError("");
		try {
			const response = await authFetch("/api/settings/google-forwarding", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: !enabled }),
			});
			const result = (await response.json()) as State & { error?: string };
			if (!response.ok) setError(result.error || t("settings.googleForwarding.updateFailed"));
			else setState(result);
		} catch {
			setError(t("settings.googleForwarding.updateFailed"));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="space-y-4 rounded-2xl border p-6">
			<h2 className="text-lg font-semibold">{t("settings.googleForwarding.title")}</h2>
			<p className="text-sm">{t("settings.googleForwarding.backup", { email: state.email ?? "" })}</p>
			<p className="text-sm text-neutral-500" data-status={status}>{t(STATUS_TEXT[status])}</p>
			<div className="flex flex-wrap gap-3">
				<Button disabled={busy} onClick={() => void toggle()}>
					{busy ? t("common.saving") : enabled ? t("settings.googleForwarding.turnOff") : t("settings.googleForwarding.turnOn")}
				</Button>
				<Button variant="outline" disabled={busy} onClick={() => void refresh().catch(() => setError(t("settings.googleForwarding.checkFailed")))}>
					{t("settings.googleForwarding.check")}
				</Button>
			</div>
			{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
		</section>
	);
}
