import { withPostHogConfig } from "@posthog/nextjs-config";
import type { NextConfig } from "next";

const posthogPersonalApiKey =
	process.env.POSTHOG_API_KEY ??
	process.env.POSTHOG_PERSONAL_API_KEY ??
	"";
const posthogProjectId = process.env.POSTHOG_PROJECT_ID;
const posthogSourcemapsEnabled =
	process.env.NODE_ENV === "production" &&
	Boolean(posthogPersonalApiKey) &&
	Boolean(posthogProjectId);

if (process.env.NODE_ENV === "production" && !posthogSourcemapsEnabled) {
	console.warn(
		"[PostHog] Source map upload disabled. Set POSTHOG_API_KEY (or POSTHOG_PERSONAL_API_KEY) and POSTHOG_PROJECT_ID to enable it.",
	);
}

const nextConfig: NextConfig = {
	cacheComponents: true,
	partialPrefetching: true,
	experimental: {
		agentUpgrade: "security",
		// lucide-react, date-fns, and recharts are optimized by default.
		optimizePackageImports: ["zod"],
	},
	// Old URLs of screens that moved into Team. Not permanent: the hub may
	// still move. Next passes the request's query through (?closer=…&schedule=1).
	async redirects() {
		const leadGenSettings = "/workspace/lead-gen/settings";
		const tab = (value: string) => [{ type: "query" as const, key: "tab", value }];
		return [
			{ source: "/workspace/booking/teams", destination: "/workspace/team/teams", permanent: false },
			{ source: "/workspace/booking/teams/:teamId", destination: "/workspace/team/teams/:teamId", permanent: false },
			{ source: leadGenSettings, has: tab("teams"), destination: "/workspace/team/teams", permanent: false },
			{
				source: leadGenSettings,
				has: tab("schedules"),
				destination: "/workspace/team/schedules?role=lead_gen",
				permanent: false,
			},
			{
				source: leadGenSettings,
				has: tab("rules"),
				destination: "/workspace/settings#lead-gen-rules",
				permanent: false,
			},
			// "workers", no tab, or anything else.
			{ source: leadGenSettings, destination: "/workspace/team?role=lead_gen", permanent: false },
		];
	},
	async rewrites() {
		return [
			{
				source: "/ingest/static/:path*",
				destination: "https://us-assets.i.posthog.com/static/:path*",
			},
			{
				source: "/ingest/:path*",
				destination: "https://us.i.posthog.com/:path*",
			},
		];
	},
	// Required to support PostHog trailing slash API requests
	skipTrailingSlashRedirect: true,
};

export default withPostHogConfig(nextConfig, {
	personalApiKey: posthogPersonalApiKey,
	projectId: posthogProjectId,
	host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
	sourcemaps: {
		enabled: posthogSourcemapsEnabled,
		deleteAfterUpload: true,
	},
});
