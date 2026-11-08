import { Suspense } from "react";
import { requirePermission } from "@/lib/auth";
import { ContentReveal, SkeletonExit } from "@/components/page-transitions";
import { EntityDetailSkeleton } from "./_components/entity-detail-skeleton";
import { EntityDetailContent } from "./_components/entity-detail-content";

export const instant = false;

export default async function LeadCustomerDetailPage({
	params,
}: {
	params: Promise<{ leadId: string }>;
}) {
	const { session } = await requirePermission("lead:view-all");
	const { leadId } = await params;

	return (
		<Suspense
			fallback={
				<SkeletonExit>
					<EntityDetailSkeleton />
				</SkeletonExit>
			}
		>
			<ContentReveal>
				<EntityDetailContent leadId={leadId} accessToken={session.accessToken} />
			</ContentReveal>
		</Suspense>
	);
}
