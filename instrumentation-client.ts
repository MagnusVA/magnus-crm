import posthog from "posthog-js";
import { convexExceptionBeforeSend } from "@/lib/observability/client-exceptions";
import { isPostHogEnabled } from "@/lib/posthog-config";

const environment = process.env.NEXT_PUBLIC_VERCEL_ENV ?? "production";

if (isPostHogEnabled()) {
	posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
		api_host: "/ingest",
		ui_host: "https://us.posthog.com",
		defaults: "2026-01-30",
		capture_exceptions: true,
		before_send: convexExceptionBeforeSend,
		// Onboarding invite tokens and OAuth codes and state travel in URLs.
		mask_personal_data_properties: true,
		custom_personal_data_properties: ["token", "code", "state"],
		capture_performance: { web_vitals: true },
		// `posthog.logger.*` sends to PostHog Logs, linked to the person and session.
		// Console capture stays off: console output includes error objects and ids.
		logs: {
			serviceName: "magnus-web",
			environment,
			captureConsoleLogs: false,
		},
		loaded: (instance) => {
			// Preview deployments share the project; tag every event so alerts can filter.
			instance.register({ environment });
		},
	});
}
