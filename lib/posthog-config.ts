/**
 * PostHog runs only in production when a project token is configured.
 * Disabled in development (`next dev`) to avoid polluting analytics and
 * unnecessary network traffic.
 */
export function isPostHogEnabled(): boolean {
	return (
		process.env.NODE_ENV === "production" &&
		Boolean(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN)
	);
}
