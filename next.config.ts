import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	cacheComponents: true,
	experimental: {
		optimizePackageImports: ["lucide-react", "date-fns", "recharts", "zod"],
		// Enable View Transition API for <Link> navigations — wraps every
		// client-side navigation in document.startViewTransition() so all
		// mounted <ViewTransition> components participate in link clicks.
		// @see vercel-react-view-transitions: Next.js Integration
		viewTransition: true,
		// Adds an "Instant Navs" panel to the Next.js DevTools overlay for
		// visual inspection of static shells during development (zero prod impact).
		// @see next-best-practices: unstable_instant validation
		instantNavigationDevToolsToggle: true,
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

export default nextConfig;
