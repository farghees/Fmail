import { redirect } from "next/navigation";
import { getGoogleAuthForPage } from "@/lib/google-auth/page";

export const dynamic = "force-dynamic";

/** First-run setup everywhere, except on hosts that open self-service sign-up with Google, where it is /signup. */
export default async function RegisterPage() {
	redirect((await getGoogleAuthForPage()) ? "/signup" : "/setup");
}
