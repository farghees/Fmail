import { AccountSettings } from "@/components/settings/account-settings";
import { GoogleForwarding } from "@/components/settings/google-forwarding";

export default function SettingsAccountPage() {
	return (
		<div className="space-y-6">
			<GoogleForwarding />
			<AccountSettings />
		</div>
	);
}
