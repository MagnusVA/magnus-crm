"use client";

import type { FunctionReturnType } from "convex/server";
import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { EntityDetailProvider } from "./entity-detail-context";
import { EntityDetailNotFound } from "./entity-detail-empty-states";
import { EntityDetailSkeleton } from "./entity-detail-skeleton";
import { EntityDetailFrame } from "./entity-detail-layout";

type EntityDetailResult = FunctionReturnType<
	typeof api.leadCustomers.detail.getEntityDetail
>;

export function EntityDetailPageClient({
	preloadedDetail,
}: {
	preloadedDetail: Preloaded<typeof api.leadCustomers.detail.getEntityDetail>;
}) {
	const router = useRouter();
	const detail = usePreloadedQuery(preloadedDetail) as
		| EntityDetailResult
		| undefined;
	const title =
		detail?.kind === "detail"
			? (detail.lead.fullName ?? detail.lead.email ?? "Lead")
			: "Lead";
	usePageTitle(title);

	useEffect(() => {
		if (detail?.kind === "redirect") {
			router.replace(`/workspace/leads-customers/${detail.leadId}`);
		}
	}, [detail, router]);

	if (detail === undefined) return <EntityDetailSkeleton />;
	if (detail === null) return <EntityDetailNotFound />;
	if (detail.kind === "redirect") return null;

	return (
		<EntityDetailProvider detail={detail}>
			<EntityDetailFrame />
		</EntityDetailProvider>
	);
}
