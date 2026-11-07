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

// Icons the browser asks for on every page. Public files default to
// max-age=0, so each request reached Vercel. A week in the browser cache
// stops that; give a changed icon a new file name.
const ICON_FILES = [
	"/favicon.ico",
	"/favicon.svg",
	"/apple-touch-icon.png",
	"/magnus-icon.svg",
	"/magnus-white.svg",
];

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
	async headers() {
		return ICON_FILES.map((source) => ({
			source,
			headers: [
				{
					key: "Cache-Control",
					value: "public, max-age=604800, stale-while-revalidate=86400",
				},
			],
		}));
	},
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
