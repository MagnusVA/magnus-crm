import posthog from "posthog-js";
import { isPostHogEnabled } from "@/lib/posthog-config";

if (isPostHogEnabled()) {
	posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
		api_host: "/ingest",
		ui_host: "https://us.posthog.com",
		defaults: "2026-01-30",
		capture_exceptions: true,
	});
}
