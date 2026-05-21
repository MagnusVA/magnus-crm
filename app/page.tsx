"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth, useQuery } from "convex/react";
import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ThemeToggle } from "@/components/theme-toggle";
import { MagnusBrand } from "@/components/magnus-brand";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";
import { DOT_GRID_STYLE } from "@/lib/dot-grid";

const STEPS = [
	"Leads book meetings through your Calendly link",
	"Closers manage meetings, notes, and payments in one dashboard",
	"Admins track pipeline, team performance, and revenue",
] as const;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
//forcing a webhook change

export default function Home() {
	const router = useRouter();
	const { isAuthenticated, isLoading } = useConvexAuth();
	const { user, organizationId, loading: authLoading } = useAuth();
	const isSystemAdmin = organizationId === SYSTEM_ADMIN_ORG_ID;
	const tenant = useQuery(
		api.tenants.getCurrentTenant,
		isAuthenticated &&
			!authLoading &&
			!!user &&
			!!organizationId &&
			!isSystemAdmin
			? {}
			: "skip",
	);

	useEffect(() => {
		if (isLoading || authLoading || !isAuthenticated || !user) return;

		if (isSystemAdmin) {
			router.replace("/admin");
			return;
		}

		if (!organizationId) {
			return;
		}

		if (tenant === undefined) {
			return;
		}

		if (tenant?.status === "active") {
			router.replace("/workspace");
			return;
		}

		router.replace("/onboarding/connect");
	}, [
		authLoading,
		isAuthenticated,
		isLoading,
		isSystemAdmin,
		organizationId,
		router,
		tenant,
		user,
	]);

	// Authenticated users are being redirected — show a loading pill
	if (
		isLoading ||
		authLoading ||
		(isAuthenticated &&
			user &&
			(!organizationId || isSystemAdmin || tenant === undefined))
	) {
		return (
			<div
				className="flex min-h-screen items-center justify-center bg-background"
				role="status"
			>
				<div className="flex items-center gap-3 rounded-full border border-border bg-card px-5 py-3 text-sm text-muted-foreground">
					<Spinner className="size-4" />
					Routing your workspace&hellip;
				</div>
			</div>
		);
	}

	// Unauthenticated landing
	return (
		<div
			className="flex min-h-screen flex-col bg-background"
			style={DOT_GRID_STYLE}
		>
			{/* Header */}
			<header className="flex items-center justify-between px-6 py-5">
				<Link
					href="/"
					aria-label="MAGNUS CRM home"
					className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				>
					<MagnusBrand
						label="MAGNUS CRM"
						size="sm"
						priority
						textClassName="text-foreground"
					/>
				</Link>
				<div className="flex items-center gap-2">
					<ThemeToggle />
					<Button asChild variant="outline" size="sm">
						<Link href="/sign-in">Sign In</Link>
					</Button>
					<Button asChild size="sm">
						<Link href="/sign-up">Create Account</Link>
					</Button>
				</div>
			</header>

			{/* Hero */}
			<main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
				<div className="flex w-full max-w-lg flex-col gap-10 text-center motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-600">
					<div className="flex flex-col items-center gap-5">
						<MagnusBrand
							label="MAGNUS CRM"
							size="lg"
							className="justify-center"
							textClassName="text-3xl text-foreground sm:text-4xl"
						/>
						<h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl text-balance">
							Sales Meetings. Pipeline Tracking. Deal Closing. All
							in One Place.
						</h1>
						<p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
							<span className="font-brand text-[1.08em] tracking-normal text-foreground">
								MAGNUS CRM
							</span>{" "}
							turns your Calendly meetings into a structured sales
							pipeline — from booking to payment, with real-time
							visibility for closers and admins.
						</p>
					</div>

					{/* Steps */}
					<ol className="flex flex-col gap-2 text-left" role="list">
						{STEPS.map((step, idx) => (
							<li
								key={step}
								className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm text-card-foreground motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-400"
								style={{
									animationDelay: `${300 + idx * 100}ms`,
								}}
							>
								<span
									className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary"
									aria-hidden="true"
								>
									{idx + 1}
								</span>
								<span className="min-w-0">{step}</span>
							</li>
						))}
					</ol>

					{/* CTA */}
					<div className="flex flex-col items-center gap-3">
						<Button asChild size="lg">
							<Link href="/sign-in">
								Get Started
								<ArrowRightIcon
									data-icon="inline-end"
									aria-hidden="true"
								/>
							</Link>
						</Button>
						<p className="text-xs text-muted-foreground">
							Sign in to access your workspace, or contact your
							admin for an invite.
						</p>
					</div>
				</div>
			</main>

			{/* Footer */}
			<footer className="flex items-center justify-between px-6 pb-5">
				<MagnusBrand
					label="MAGNUS CRM"
					size="xs"
					textClassName="text-base text-muted-foreground/70"
				/>
				<div className="flex gap-4 text-[11px] text-muted-foreground/60">
					<Link
						href="/privacy"
						className="underline-offset-4 hover:text-muted-foreground hover:underline"
					>
						Privacy
					</Link>
					<Link
						href="/support"
						className="underline-offset-4 hover:text-muted-foreground hover:underline"
					>
						Support
					</Link>
				</div>
			</footer>
		</div>
	);
}
