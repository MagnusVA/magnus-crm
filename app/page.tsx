"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { api } from "@/convex/_generated/api";
import { PublicShell } from "@/components/public-shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PageBand } from "@/app/workspace/_components/page-band";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";
import { cn } from "@/lib/utils";

const STEPS = [
	"Leads book meetings through your Calendly link",
	"Closers manage meetings, notes and payments in one place",
	"Admins track pipeline, team performance and revenue",
] as const;

/** The band's board-tone outline button (Billing's and Missed meetings' band buttons). */
const BAND_BUTTON =
	"h-[34px] rounded-[7px] border-board-foreground/15 bg-board-raised px-3 text-[13px] text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10";

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

	// Signed-in users are on their way to their workspace: one line while it routes.
	if (
		isLoading ||
		authLoading ||
		(isAuthenticated &&
			user &&
			(!organizationId || isSystemAdmin || tenant === undefined))
	) {
		return (
			<PublicShell signIn={false}>
				<div
					role="status"
					className={cn(CARD, "flex min-h-11 items-center gap-2.5 px-4 py-2.5")}
				>
					<Spinner aria-hidden="true" className="text-muted-foreground" />
					<h1 className="text-sm">Routing your workspace&hellip;</h1>
				</div>
			</PublicShell>
		);
	}

	return (
		<PublicShell signIn={false}>
			<PageBand
				title="Meetings, pipeline and deals in one place"
				description="Magnus turns Calendly meetings into a sales pipeline, from booking to payment."
				actions={
					<div className="flex flex-wrap items-center gap-2 @max-lg:basis-full">
						<Button asChild className="h-[34px] px-3 font-semibold">
							<Link href="/sign-in">Sign in</Link>
						</Button>
						<Button asChild variant="outline" className={BAND_BUTTON}>
							<Link href="/sign-up">Create account</Link>
						</Button>
					</div>
				}
			/>

			<section aria-labelledby="how-it-works" className={CARD}>
				<CardHead title={<span id="how-it-works">How it works</span>} />
				<ol>
					{STEPS.map((step, idx) => (
						<li
							key={step}
							className="flex min-h-11 items-baseline gap-3 border-t border-border px-4 py-2.5 text-sm first:border-t-0"
						>
							<span
								aria-hidden="true"
								className="w-3 shrink-0 font-condensed text-[15px] font-semibold text-muted-foreground tabular-nums"
							>
								{idx + 1}
							</span>
							<span className="min-w-0 text-pretty">{step}</span>
						</li>
					))}
				</ol>
			</section>

			<p className="text-[13px] text-muted-foreground">
				No account yet? Your admin sends you an invite.
			</p>
		</PublicShell>
	);
}
