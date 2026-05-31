import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { EntityDetailPageClient } from "./entity-detail-page-client";

export async function EntityDetailContent({
	leadId,
	accessToken,
}: {
	leadId: string;
	accessToken: string;
}) {
	const preloadedDetail = await preloadQuery(
		api.leadCustomers.detail.getEntityDetail,
		{ leadId: leadId as Id<"leads"> },
		{ token: accessToken },
	);

	return <EntityDetailPageClient preloadedDetail={preloadedDetail} />;
}
