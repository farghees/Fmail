import { notFound, redirect } from "next/navigation";
import { AuthGuard } from "@/components/auth/auth-guard";
import { getGoogleAuthForPage, getGoogleIdentityForPage } from "@/lib/google-auth/page";
import { authPageMetadata } from "../auth-metadata";
import { SignupClient } from "./signup-client";

export const dynamic = "force-dynamic";

export const generateMetadata = () => authPageMetadata("auth.signup.title");

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ step?: string; error?: string }> }) {
	const google = await getGoogleAuthForPage();
	if (!google) notFound();
	const { step, error } = await searchParams;
	if (step === "username") {
		const verified = await getGoogleIdentityForPage();
		if (!verified) redirect("/signup?error=expired");
		return (
			<AuthGuard mode="public">
				<SignupClient domain={google.domain} email={verified.identity.email} errorCode={null} />
			</AuthGuard>
		);
	}
	return (
		<AuthGuard mode="public">
			<SignupClient domain={google.domain} email={null} errorCode={error ?? null} />
		</AuthGuard>
	);
}
