import { convexExceptionBeforeSend } from "@/lib/observability/client-exceptions";
import { attachPostHog, postHogUnavailable } from "@/lib/posthog-browser";
import { isPostHogEnabled } from "@/lib/posthog-config";

const environment = process.env.NEXT_PUBLIC_VERCEL_ENV ?? "production";

if (isPostHogEnabled()) {
	// posthog-js is about 100 KB of gzip that no page needs to render, so it
	// loads on its own chunk. Errors thrown before it starts wait here.
	const earlyErrors: unknown[] = [];
	const onError = (event: ErrorEvent) => earlyErrors.push(event.error ?? event.message);
	const onRejection = (event: PromiseRejectionEvent) => earlyErrors.push(event.reason);
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);

	void import("posthog-js")
		.then(({ default: posthog }) => {
			posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
				// Straight to PostHog, not through a /ingest rewrite: every rewritten
				// request was a Vercel CDN request.
				api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
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
			window.removeEventListener("error", onError);
			window.removeEventListener("unhandledrejection", onRejection);
			for (const error of earlyErrors.splice(0)) posthog.captureException(error);
			attachPostHog(posthog);
		})
		.catch(() => {
			// Analytics never break the app.
			window.removeEventListener("error", onError);
			window.removeEventListener("unhandledrejection", onRejection);
			postHogUnavailable();
		});
}
